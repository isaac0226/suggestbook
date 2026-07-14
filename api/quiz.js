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
  const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20&printType=books`);
  if (!response.ok) return [];
  const result = await response.json();
  return (result.items || []).map((item) => {
    const info = item.volumeInfo || {};
    const candidate = {
      id: item.id || '',
      title: info.title || title,
      subtitle: info.subtitle || '',
      authors: info.authors || [],
      publisher: info.publisher || '',
      publishedDate: info.publishedDate || '',
      description: (info.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000),
      categories: info.categories || [],
      isbn: (info.industryIdentifiers || []).find((entry) => entry.type === 'ISBN_13')?.identifier || '',
    };
    return { ...candidate, score: scoreCandidate(candidate, title, identity) };
  });
}

async function searchGoogleBooks(title, identity) {
  const queries = [
    [title, identity].filter(Boolean).join(' '),
    `intitle:${title}`,
    title,
  ];
  const results = await Promise.all([...new Set(queries)].map((query) => searchGoogleBooksQuery(query, title, identity)));
  const unique = new Map();
  results.flat().forEach((candidate) => {
    const key = candidate.isbn || candidate.id || `${normalizeText(candidate.title)}-${normalizeText(candidate.publisher)}`;
    const previous = unique.get(key);
    if (!previous || candidate.score > previous.score) unique.set(key, candidate);
  });
  return [...unique.values()].sort((a, b) => b.score - a.score)[0] || null;
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
  const match = await searchGoogleBooks(identified.title, identity);
  const titleMatch = match ? similarity(identified.title, match.title) : 0;
  if (!match || titleMatch < 0.72 || match.score < 0.58) {
    return {
      title: identified.title,
      author: identified.author || identified.publisher || '저자 정보 없음',
      publisher: identified.publisher || '',
      description: '',
      categories: [],
      isbn: '',
      confidence: identified.confidence || 0,
      catalogMatched: false,
    };
  }
  return {
    title: identified.title,
    catalogTitle: match.title,
    author: identified.author || match.authors.join(', ') || identified.publisher || '저자 정보 없음',
    publisher: identified.publisher || match.publisher || '',
    description: match.description,
    categories: match.categories,
    isbn: match.isbn,
    publishedDate: match.publishedDate,
    confidence: Math.max(identified.confidence || 0, match.score),
    catalogMatched: true,
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
    const identified = await identifyBookFromCover({
      apiKey,
      model,
      coverImage,
      manualTitle: title.trim(),
      manualIdentity: author.trim(),
    });
    const book = await resolveIdentifiedBook(identified);

    const hasCatalogContent = Boolean(book.description && book.description.length >= 100);
    const hasSupportContent = supportImages.length > 0;
    if (!hasCatalogContent && !hasSupportContent) {
      return send(res, 422, {
        message: `「${book.title}」 책은 확인했지만, 내용 문제를 만들 자료가 부족합니다. 뒷표지 책 소개, 목차 또는 본문 사진을 1장 이상 추가해 주세요.`,
        matchedBook: book,
      });
    }

    const reference = [
      `확인된 책 제목: ${book.title}`,
      `저자: ${book.author}`,
      book.publisher ? `출판사: ${book.publisher}` : '',
      book.isbn ? `ISBN: ${book.isbn}` : '',
      book.categories?.length ? `분류: ${book.categories.join(', ')}` : '',
      hasCatalogContent ? `공개 도서 소개: ${book.description}` : '',
      hasSupportContent ? `뒷표지·목차·본문 참고 사진: ${supportImages.length}장` : '',
    ].filter(Boolean).join('\n');

    const prompt = `당신은 한국 초등학생을 위한 정확한 독서퀴즈 출제자입니다.
${reference}
대상: ${grade}
문제 수: ${questionCount}

절대 규칙:
1. 앞표지는 책 식별에만 사용했습니다. 앞표지 그림, 표지 문구, 제목, 저자, 출판사, 권수를 정답으로 묻는 문제는 절대 만들지 마세요.
2. 반드시 책의 실제 내용, 개념, 사건, 인물의 행동, 원인과 결과, 핵심 메시지를 묻는 문제만 만드세요.
3. 첨부된 참고 사진이 있다면 그 사진에 보이는 뒷표지 소개·목차·본문을 최우선 근거로 사용하세요.
4. 공개 도서 소개에 없는 세부 내용이나 사진에서 읽히지 않는 내용을 추측하지 마세요.
5. 같은 시리즈의 다른 권이나 비슷한 제목의 다른 책 내용을 섞지 마세요.
6. “이 책의 제목은?”, “저자는 누구인가?”, “표지에 무엇이 보이는가?”, “표지에는 어떤 문구가 있는가?” 같은 문제는 금지입니다.
7. 근거가 부족해 ${questionCount}개의 내용 문제를 만들 수 없다면 JSON의 error에 “책은 확인했지만 내용 문제를 만들 자료가 부족합니다. 뒷표지, 목차 또는 본문 사진을 추가해 주세요.”라고 적으세요.
8. 선택지는 정확히 4개이며 정답은 0부터 3까지의 배열 인덱스입니다.
9. 초등학생이 이해할 수 있는 자연스러운 한국어를 사용하세요.
10. explanation에는 어떤 공개 소개나 참고 사진 내용에 근거했는지 간단히 설명하세요.
11. skill은 12자 이내로 쓰세요. 예: 핵심 개념, 원인과 결과, 내용 이해, 인물 이해.

반드시 JSON만 출력하세요.
{"title":"확인된 책 제목","author":"확인된 저자","questions":[{"question":"책 내용에 관한 문제","options":["선택지1","선택지2","선택지3","선택지4"],"answer":0,"hint":"정답을 직접 밝히지 않는 힌트","skill":"확인 능력","explanation":"정답 근거"}]}`;

    const result = await callGemini({
      apiKey,
      model,
      prompt,
      images: supportImages,
      maxOutputTokens: questionCount === 10 ? 4800 : questionCount === 5 ? 2700 : 1800,
      temperature: 0.1,
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
      sourceMode: hasSupportContent ? 'catalog_and_support_photos' : 'catalog_description',
    });
  } catch (error) {
    console.error('quiz generation error', error);
    const message = error.message || '퀴즈 생성 중 오류가 발생했습니다.';
    if (/high demand|overloaded|temporarily unavailable/i.test(message)) return send(res, 503, { message: '지금 퀴즈 요청이 많아 잠시 혼잡합니다. 잠시 후 다시 시도해 주세요.' });
    if (/quota exceeded|rate limit|resource_exhausted/i.test(message)) return send(res, 429, { message: '잠시 동안 퀴즈 요청이 많았습니다. 10초 정도 후 다시 시도해 주세요.' });
    if (/문제 수가 올바르지 않습니다/.test(message)) return send(res, 422, { message: '내용 문제 형식이 정확히 만들어지지 않았습니다. 같은 자료로 다시 한 번 시도해 주세요.' });
    return send(res, 500, { message });
  }
}
