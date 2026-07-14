const ALLOWED_COUNTS = new Set([3, 5, 10]);
const MAX_IMAGES = 3;

function send(res, status, payload) {
  res.status(status).json(payload);
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI 응답에서 JSON 형식을 찾지 못했습니다.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeText(value = '') {
  return value.toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
}

function similarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length);
}

function validateQuiz(data, expectedCount) {
  if (!data || !Array.isArray(data.questions) || data.questions.length !== expectedCount) {
    throw new Error('문제 수가 올바르지 않습니다.');
  }
  data.questions.forEach((item) => {
    if (!item.question || !Array.isArray(item.options) || item.options.length !== 4) throw new Error('문제 형식이 올바르지 않습니다.');
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) throw new Error('정답 형식이 올바르지 않습니다.');
    if (!item.hint) item.hint = '책의 내용을 다시 떠올려 보세요.';
    if (!item.explanation) item.explanation = '책에서 확인한 내용을 바탕으로 한 정답입니다.';
    if (!item.skill) item.skill = '내용 이해';
  });
  return data;
}

function normalizeModel() {
  return 'gemini-3.1-flash-lite';
}

function parseImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  return { inlineData: { mimeType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data: match[2] } };
}

async function callGemini({ apiKey, model, prompt, images = [], maxOutputTokens = 128, temperature = 0 }) {
  const parts = [{ text: prompt }, ...images.map(parseImage).filter(Boolean)];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature, maxOutputTokens } }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message || 'Gemini API 요청에 실패했습니다.');
  return result;
}

function scoreCandidate(candidate, title, identity) {
  const creators = [...candidate.authors, candidate.publisher].filter(Boolean).join(' ');
  const titleScore = similarity(title, candidate.title);
  const identityScore = identity ? similarity(identity, creators) : 0.5;
  return Math.min(1, titleScore * 0.84 + identityScore * 0.16);
}

async function searchGoogleBooksQuery(query, title, identity) {
  try {
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20&printType=books`);
    if (!response.ok) return [];
    const result = await response.json();
    return (result.items || []).map((item) => {
      const info = item.volumeInfo || {};
      const candidate = {
        id: item.id || '',
        title: info.title || title,
        authors: info.authors || [],
        publisher: info.publisher || '',
        publishedDate: info.publishedDate || '',
        description: (info.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000),
        categories: info.categories || [],
        isbn: (info.industryIdentifiers || []).find((entry) => entry.type === 'ISBN_13')?.identifier || '',
      };
      return { ...candidate, score: scoreCandidate(candidate, title, identity) };
    });
  } catch {
    return [];
  }
}

async function searchGoogleBooks(title, identity) {
  const queries = [[title, identity].filter(Boolean).join(' '), `intitle:${title}`, title];
  const results = await Promise.all([...new Set(queries)].map((query) => searchGoogleBooksQuery(query, title, identity)));
  const unique = new Map();
  results.flat().forEach((candidate) => {
    const key = candidate.isbn || candidate.id || `${normalizeText(candidate.title)}-${normalizeText(candidate.publisher)}`;
    const previous = unique.get(key);
    if (!previous || candidate.score > previous.score) unique.set(key, candidate);
  });
  return [...unique.values()].sort((a, b) => b.score - a.score)[0] || null;
}

async function searchOpenLibrary(title, identity) {
  try {
    const query = new URLSearchParams({ title, limit: '10', fields: 'key,title,author_name,publisher,first_publish_year,subject,isbn' });
    const response = await fetch(`https://openlibrary.org/search.json?${query.toString()}`);
    if (!response.ok) return null;
    const result = await response.json();
    const candidates = (result.docs || []).map((doc) => ({
      title: doc.title || '',
      authors: doc.author_name || [],
      publisher: doc.publisher?.[0] || '',
      publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
      categories: (doc.subject || []).slice(0, 12),
      isbn: doc.isbn?.[0] || '',
      description: '',
      score: scoreCandidate({ title: doc.title || '', authors: doc.author_name || [], publisher: doc.publisher?.[0] || '' }, title, identity),
    }));
    return candidates.sort((a, b) => b.score - a.score)[0] || null;
  } catch {
    return null;
  }
}

async function identifyBookFromCover({ apiKey, model, coverImage, manualTitle, manualIdentity }) {
  const prompt = `이 이미지는 책의 앞표지입니다. 퀴즈를 만들지 말고 책 식별 정보만 정확히 읽으세요.
사용자가 직접 입력한 제목(선택): ${manualTitle || '없음'}
사용자가 직접 입력한 저자·출판사(선택): ${manualIdentity || '없음'}

규칙:
1. 표지에서 실제로 읽히는 제목, 부제, 권수, 시리즈명을 빠뜨리지 마세요.
2. 저자, 글, 그림, 기획, 출판사를 구분해 읽으세요.
3. 도서관 스티커의 도서관명과 청구기호는 책 정보가 아닙니다.
4. 보이지 않는 정보는 추측하지 마세요.
5. 사용자의 직접 입력보다 표지의 실제 글자를 우선하되, 흐린 글자를 보완할 때만 참고하세요.

JSON만 출력하세요.
{"title":"정확한 전체 책 제목","author":"대표 저자 또는 글쓴이","illustrator":"그림 작가 또는 빈 문자열","publisher":"출판사 또는 빈 문자열","series":"시리즈명 또는 빈 문자열","volume":"권수 또는 빈 문자열","confidence":0.0}`;
  const result = await callGemini({ apiKey, model, prompt, images: [coverImage], maxOutputTokens: 360, temperature: 0 });
  const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  const identified = extractJson(text);
  if (!identified?.title || (identified.confidence ?? 0) < 0.55) {
    throw new Error('앞표지에서 책 제목을 정확히 읽지 못했습니다. 제목이 선명하게 보이도록 다시 촬영해 주세요.');
  }
  return identified;
}

async function resolveIdentifiedBook(identified) {
  const identity = identified.author || identified.publisher || '';
  const [googleMatch, openLibraryMatch] = await Promise.all([
    searchGoogleBooks(identified.title, identity),
    searchOpenLibrary(identified.title, identity),
  ]);
  const candidates = [googleMatch, openLibraryMatch].filter(Boolean).filter((item) => similarity(identified.title, item.title) >= 0.72);
  const match = candidates.sort((a, b) => b.score - a.score)[0] || null;
  return {
    title: identified.title,
    catalogTitle: match?.title || '',
    author: identified.author || match?.authors?.join(', ') || identified.publisher || '저자 정보 없음',
    publisher: identified.publisher || match?.publisher || '',
    description: match?.description || '',
    categories: match?.categories || [],
    isbn: match?.isbn || '',
    publishedDate: match?.publishedDate || '',
    confidence: Math.max(identified.confidence || 0, match?.score || 0),
    catalogMatched: Boolean(match),
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = normalizeModel();

  if (req.method === 'GET' && req.query?.health === '1') {
    if (!apiKey) return send(res, 503, { ok: false, configured: false, model, message: 'GEMINI_API_KEY가 없습니다.' });
    try {
      await callGemini({ apiKey, model, prompt: 'Reply with only OK.', maxOutputTokens: 8, temperature: 0 });
      return send(res, 200, { ok: true, configured: true, model });
    } catch (error) {
      return send(res, 502, { ok: false, configured: true, model, message: error.message });
    }
  }

  if (req.method !== 'POST') return send(res, 405, { message: 'POST 요청만 사용할 수 있습니다.' });

  const { grade, title = '', author = '', count, images = [] } = req.body || {};
  const questionCount = Number(count);
  const safeImages = Array.isArray(images) ? images.slice(0, MAX_IMAGES).filter((image) => parseImage(image)) : [];
  if (!grade || !ALLOWED_COUNTS.has(questionCount)) return send(res, 400, { message: '학년과 문제 수를 확인해 주세요.' });
  if (!safeImages.length) return send(res, 400, { message: '책 앞표지 사진을 먼저 촬영해 주세요.' });
  if (!apiKey) return send(res, 503, { message: 'Vercel 환경변수에 GEMINI_API_KEY를 등록하면 퀴즈를 만들 수 있어요.' });

  try {
    const coverImage = safeImages[0];
    const supportImages = safeImages.slice(1);
    const identified = await identifyBookFromCover({ apiKey, model, coverImage, manualTitle: title.trim(), manualIdentity: author.trim() });
    const book = await resolveIdentifiedBook(identified);
    const hasCatalogContent = Boolean(book.description && book.description.length >= 80);
    const hasSupportContent = supportImages.length > 0;

    const reference = [
      `정확히 식별한 책 제목: ${book.title}`,
      `저자: ${book.author}`,
      book.publisher ? `출판사: ${book.publisher}` : '',
      book.isbn ? `ISBN: ${book.isbn}` : '',
      book.categories?.length ? `도서 분류·주제어: ${book.categories.join(', ')}` : '',
      hasCatalogContent ? `공개 도서 소개: ${book.description}` : '공개 도서 소개 전문은 확보하지 못함',
      hasSupportContent ? `사용자가 제공한 뒷표지·목차·본문 사진: ${supportImages.length}장` : '추가 내용 사진 없음',
    ].filter(Boolean).join('\n');

    const prompt = `당신은 한국 초등학생용 독서퀴즈 출제자입니다.
${reference}
대상: ${grade}
문제 수: ${questionCount}

작업 순서:
1. 먼저 위 제목·저자·출판사로 정확히 어떤 책인지 식별하세요.
2. 공개 도서 소개, 주제어, 사용자가 제공한 참고 사진, 그리고 당신이 이 정확한 책에 대해 확실히 알고 있는 내용만 종합하세요.
3. 앞표지는 책 식별에만 사용했으므로 앞표지 자체를 문제 근거로 사용하지 마세요.
4. 책의 실제 내용·개념·사건·인물 행동·원인과 결과·핵심 메시지를 묻는 문제만 만드세요.
5. “제목은 무엇인가”, “저자는 누구인가”, “표지에 무엇이 보이는가”, “표지 문구는 무엇인가”, “출판사는 어디인가”는 절대 출제하지 마세요.
6. 같은 시리즈의 다른 권이나 제목이 비슷한 다른 책 내용을 섞지 마세요.
7. 확실하지 않은 인물명, 사건, 숫자, 대사, 세부 장면을 지어내지 마세요.
8. 참고 사진이 있으면 그 사진의 실제 내용을 최우선 근거로 사용하세요.
9. 정확한 내용 문제를 ${questionCount}개 만들 자신이 없을 때만 JSON의 error에 “책은 확인했지만 정확한 내용 문제를 만들 자료가 부족합니다. 뒷표지, 목차 또는 본문 사진을 추가해 주세요.”라고 적으세요.
10. 단순히 공개 소개 전문이 없다는 이유만으로 바로 거절하지 말고, 정확히 알고 있는 책이라면 실제 내용에 근거해 출제하세요.
11. 선택지는 정확히 4개이며 정답은 0부터 3까지의 배열 인덱스입니다.
12. explanation은 정답이 되는 이유를 책 내용에 근거해 한두 문장으로 설명하세요.
13. skill은 12자 이내로 쓰세요. 예: 핵심 개념, 원인과 결과, 내용 이해, 인물 이해.

반드시 JSON만 출력하세요.
{"title":"확인된 책 제목","author":"확인된 저자","questions":[{"question":"책 내용에 관한 문제","options":["선택지1","선택지2","선택지3","선택지4"],"answer":0,"hint":"정답을 직접 밝히지 않는 힌트","skill":"확인 능력","explanation":"정답 근거"}]}`;

    const result = await callGemini({
      apiKey,
      model,
      prompt,
      images: supportImages,
      maxOutputTokens: questionCount === 10 ? 4800 : questionCount === 5 ? 2700 : 1800,
      temperature: 0.08,
    });
    const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const parsed = extractJson(text);
    if (parsed.error) return send(res, 422, { message: parsed.error, matchedBook: book });
    const quiz = validateQuiz(parsed, questionCount);
    return send(res, 200, {
      ...quiz,
      title: book.title,
      author: book.author,
      grade,
      matchedBook: book,
      model,
      usedPhotos: safeImages.length,
      contentSource: hasSupportContent ? 'support_photos' : hasCatalogContent ? 'catalog' : 'known_book',
    });
  } catch (error) {
    console.error('quiz generation error', error);
    const message = error.message || '퀴즈 생성 중 오류가 발생했습니다.';
    if (/high demand|overloaded|temporarily unavailable/i.test(message)) return send(res, 503, { message: '지금 퀴즈 요청이 많아 잠시 혼잡합니다. 잠시 후 다시 시도해 주세요.' });
    if (/quota exceeded|rate limit|resource_exhausted/i.test(message)) return send(res, 429, { message: '잠시 동안 퀴즈 요청이 많았습니다. 10초 정도 후 다시 시도해 주세요.' });
    if (/문제 수가 올바르지 않습니다/.test(message)) return send(res, 422, { message: '문제 형식이 정확히 만들어지지 않았습니다. 같은 내용으로 다시 한 번 시도해 주세요.' });
    return send(res, 500, { message });
  }
}
