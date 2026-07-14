const ALLOWED_COUNTS = new Set([3, 5, 10]);
const MAX_IMAGES = 3;

function send(res, status, payload) {
  res.status(status).json(payload);
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI 응답에서 퀴즈 형식을 찾지 못했습니다.');
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
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length);
}

function validateQuiz(data, expectedCount) {
  if (!data || !Array.isArray(data.questions) || data.questions.length !== expectedCount) throw new Error('문제 수가 올바르지 않습니다.');
  data.questions.forEach((item) => {
    if (!item.question || !Array.isArray(item.options) || item.options.length !== 4) throw new Error('문제 형식이 올바르지 않습니다.');
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) throw new Error('정답 형식이 올바르지 않습니다.');
    if (!item.hint) item.hint = '문제가 묻는 인물이나 장면을 책에서 다시 떠올려 보세요.';
    if (!item.explanation) item.explanation = '책의 해당 장면을 다시 떠올려 보세요.';
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
  const titleContains = normalizeText(candidate.title).includes(normalizeText(title)) || normalizeText(title).includes(normalizeText(candidate.title));
  const seriesBonus = titleContains && normalizeText(candidate.title) !== normalizeText(title) ? 0.08 : 0;
  return Math.min(1, titleScore * 0.76 + identityScore * 0.16 + seriesBonus);
}

async function searchGoogleBooksQuery(query, title, identity) {
  const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20&printType=books`);
  if (!response.ok) return [];
  const result = await response.json();
  return (result.items || []).map((item) => {
    const info = item.volumeInfo || {};
    const candidate = {
      id: item.id || '', title: info.title || title, subtitle: info.subtitle || '', authors: info.authors || [], publisher: info.publisher || '', publishedDate: info.publishedDate || '',
      description: (info.description || '').replace(/<[^>]+>/g, ' ').slice(0, 3500), categories: info.categories || [],
      isbn: (info.industryIdentifiers || []).find((entry) => entry.type === 'ISBN_13')?.identifier || '',
    };
    return { ...candidate, score: scoreCandidate(candidate, title, identity) };
  });
}

async function searchGoogleBooks(title, identity, extraTerms = []) {
  const queries = [[title, identity].filter(Boolean).join(' '), `intitle:${title}`, title, ...extraTerms.filter(Boolean).map((term) => [title, term].join(' '))];
  const results = await Promise.all([...new Set(queries)].map((query) => searchGoogleBooksQuery(query, title, identity)));
  const unique = new Map();
  results.flat().forEach((candidate) => {
    const key = candidate.isbn || candidate.id || `${normalizeText(candidate.title)}-${normalizeText(candidate.publisher)}`;
    const previous = unique.get(key);
    if (!previous || candidate.score > previous.score) unique.set(key, candidate);
  });
  return [...unique.values()].sort((a, b) => b.score - a.score)[0] || null;
}

async function expandBookIdentity({ apiKey, model, title, identity }) {
  const prompt = `사용자가 책 표지에서 크게 보이는 제목과, 저자·옮긴이·출판사·브랜드·제작사 중 하나로 보이는 정보를 입력했습니다. 표지의 작은 시리즈명이나 캐릭터 브랜드명은 사용자가 빼먹었을 수 있습니다. 오타, 띄어쓰기 오류, 외국인 이름 표기 차이도 허용하세요.\n\n입력 제목: ${title}\n입력 보조 정보: ${identity}\n\n해야 할 일:\n1. 입력 제목을 핵심 부제 또는 권별 제목으로 보고, 앞에 생략된 시리즈명·브랜드명이 있는지 판단하세요.\n2. 보조 정보가 저자인지, 옮긴이인지, 출판사인지, 브랜드인지, 제작사인지 추정하세요.\n3. 실제 책을 확실히 식별할 수 있을 때만 정식 제목을 확장하세요. 모르면 입력값을 유지하세요.\n4. 책 내용을 지어내지 말고 식별 정보만 반환하세요.\n\nJSON만 출력하세요.\n{"canonicalTitle":"정식 전체 제목 또는 입력 제목","shortTitle":"표지에서 크게 보이는 제목","series":"시리즈·브랜드명 또는 빈 문자열","creator":"확인된 저자·글·그림 또는 빈 문자열","publisher":"확인된 출판사 또는 빈 문자열","brand":"브랜드·제작사 또는 빈 문자열","identityRole":"author|translator|publisher|brand|producer|unknown","searchTerms":["추가 검색어"],"confidence":0.0}`;
  const result = await callGemini({ apiKey, model, prompt, maxOutputTokens: 320, temperature: 0 });
  const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return extractJson(text);
}

async function resolveBook({ apiKey, model, title, identity }) {
  let match = await searchGoogleBooks(title, identity);
  let expanded = null;
  if (!match || match.score < 0.72 || !match.description) {
    try {
      expanded = await expandBookIdentity({ apiKey, model, title, identity });
      if (expanded?.confidence >= 0.58) {
        const expandedMatch = await searchGoogleBooks(expanded.canonicalTitle || title, expanded.creator || expanded.publisher || expanded.brand || identity, [expanded.series, expanded.brand, expanded.publisher, ...(expanded.searchTerms || [])]);
        if (expandedMatch && (!match || expandedMatch.score >= match.score - 0.03)) match = expandedMatch;
      }
    } catch { expanded = null; }
  }
  const titleMatch = match ? similarity(title, match.title) : 0;
  if (match && match.score >= 0.58 && titleMatch >= 0.72) {
    const canonicalTitle = expanded?.confidence >= 0.7 && expanded.canonicalTitle ? expanded.canonicalTitle : match.title;
    return {
      title: canonicalTitle, catalogTitle: match.title, shortTitle: title, series: expanded?.series || '',
      author: match.authors.join(', ') || expanded?.creator || match.publisher || identity,
      publisher: match.publisher || expanded?.publisher || '', brand: expanded?.brand || '', identityRole: expanded?.identityRole || 'unknown',
      publishedDate: match.publishedDate, description: match.description, categories: match.categories, isbn: match.isbn,
      confidence: Math.max(match.score, expanded?.confidence || 0), corrected: normalizeText(canonicalTitle) !== normalizeText(title), originalTitle: title, originalAuthor: identity,
    };
  }
  return {
    title: expanded?.confidence >= 0.72 ? expanded.canonicalTitle : title, catalogTitle: '', shortTitle: title, series: expanded?.series || '',
    author: expanded?.creator || expanded?.publisher || expanded?.brand || identity, publisher: expanded?.publisher || '', brand: expanded?.brand || '', identityRole: expanded?.identityRole || 'unknown',
    publishedDate: '', description: '', categories: [], isbn: '', confidence: expanded?.confidence || 0,
    corrected: Boolean(expanded?.confidence >= 0.72 && normalizeText(expanded.canonicalTitle) !== normalizeText(title)), originalTitle: title, originalAuthor: identity,
  };
}

function photoBasedBook(title, identity) {
  return {
    title, catalogTitle: '', shortTitle: title, series: '', author: identity, publisher: '', brand: '', identityRole: 'unknown',
    publishedDate: '', description: '', categories: [], isbn: '', confidence: 1, corrected: false, originalTitle: title, originalAuthor: identity,
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = normalizeModel();

  if (req.method === 'GET' && req.query?.models === '1') {
    if (!apiKey) return send(res, 503, { ok: false, configured: false, message: 'GEMINI_API_KEY가 없습니다.' });
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || '모델 목록 조회에 실패했습니다.');
      const models = (result.models || []).filter((item) => item.supportedGenerationMethods?.includes('generateContent')).map((item) => item.name?.replace(/^models\//, '')).filter((name) => name?.includes('flash'));
      return send(res, 200, { ok: true, models });
    } catch (error) { return send(res, 502, { ok: false, message: error.message }); }
  }

  if (req.method === 'GET' && req.query?.health === '1') {
    if (!apiKey) return send(res, 503, { ok: false, configured: false, model, message: 'GEMINI_API_KEY가 없습니다.' });
    try {
      await callGemini({ apiKey, model, prompt: 'Reply with only OK.', maxOutputTokens: 8, temperature: 0 });
      return send(res, 200, { ok: true, configured: true, model });
    } catch (error) { return send(res, 502, { ok: false, configured: true, model, message: error.message }); }
  }

  if (req.method !== 'POST') return send(res, 405, { message: 'POST 요청만 사용할 수 있습니다.' });

  const { grade, title, author, count, images = [] } = req.body || {};
  const questionCount = Number(count);
  const safeImages = Array.isArray(images) ? images.slice(0, MAX_IMAGES).filter((image) => parseImage(image)) : [];
  if (!grade || !title?.trim() || !author?.trim() || !ALLOWED_COUNTS.has(questionCount)) return send(res, 400, { message: '학년, 책 이름, 저자·옮긴이·출판사, 문제 수를 확인해 주세요.' });
  if (!apiKey) return send(res, 503, { message: 'Vercel 환경변수에 GEMINI_API_KEY를 등록하면 퀴즈를 만들 수 있어요.' });

  try {
    const inputTitle = title.trim();
    const inputIdentity = author.trim();
    const book = safeImages.length
      ? photoBasedBook(inputTitle, inputIdentity)
      : await resolveBook({ apiKey, model, title: inputTitle, identity: inputIdentity });
    const reference = [
      `사용자가 입력한 제목: ${inputTitle}`, `사용자가 입력한 저자·출판사 정보: ${inputIdentity}`,
      safeImages.length ? '첨부 사진이 있으므로 검색 결과보다 사진 표지와 본문을 우선함' : `확인된 전체 제목: ${book.title}`,
      !safeImages.length && book.series ? `시리즈·브랜드: ${book.series}` : '',
      !safeImages.length ? `확인된 저자·출판사·브랜드: ${book.author}${book.publisher ? ` / ${book.publisher}` : ''}${book.brand ? ` / ${book.brand}` : ''}` : '',
      !safeImages.length && book.publishedDate ? `출간 정보: ${book.publishedDate}` : '',
      !safeImages.length && book.isbn ? `ISBN: ${book.isbn}` : '',
      !safeImages.length && book.categories.length ? `분류: ${book.categories.join(', ')}` : '',
      !safeImages.length && book.description ? `공식 도서 설명: ${book.description}` : '',
      safeImages.length ? `사용자가 책 사진 ${safeImages.length}장을 제공함` : '사용자 제공 사진 없음',
    ].filter(Boolean).join('\n');

    const prompt = `당신은 한국 초등학생을 위한 정확한 독서퀴즈 출제자입니다.\n${reference}\n대상: ${grade}\n문제 수: ${questionCount}\n\n중요 규칙:\n1. 첨부 사진이 있으면 표지에 실제로 적힌 책 제목, 권수, 부제, 저자·기획·출판사를 먼저 정확히 읽으세요. 검색으로 추정한 다른 책 이름으로 바꾸면 안 됩니다.\n2. 첨부 사진이 있으면 사진에 실제로 보이는 글과 장면을 가장 우선적인 근거로 사용하세요. 사진에 없는 내용을 추측하지 마세요.\n3. 사진은 표지, 뒷표지 소개, 본문, 판권 페이지일 수 있습니다. 읽을 수 있는 내용만 사용하고 흐리거나 잘린 부분은 추정하지 마세요.\n4. 사용자가 입력한 책과 사진 속 책이 다르면 사진 속 책을 기준으로 title과 author를 정확히 반환하세요.\n5. 같은 시리즈의 다른 권이나 제목이 비슷한 다른 책, 원작 애니메이션의 다른 회차를 섞지 마세요.\n6. 사진이 없으면 공식 도서 설명과 널리 확인되는 실제 내용만 사용하세요.\n7. 문제 수만큼 정확한 문제를 만들 수 없다면 지어내지 말고 JSON의 error에 “사진이나 공개 정보에서 퀴즈를 만들 만큼 책 내용을 충분히 확인하기 어렵습니다. 뒷표지나 본문을 더 선명하게 촬영해 주세요.”라고 적으세요.\n8. 선택지는 정확히 4개이며 정답은 0부터 3까지의 배열 인덱스입니다.\n9. 모호하거나 의견에 따라 답이 달라지는 문제, 제목만 보고 맞힐 수 있는 문제는 만들지 마세요.\n10. explanation은 사진이나 확인된 책 내용에 따른 정답 근거를 한두 문장으로 설명하세요.\n11. hint는 정답을 직접 말하지 않고 장면이나 인물을 떠올리게 하는 한 문장으로 쓰세요.\n12. skill은 해당 문제가 확인하는 능력을 12자 이내로 쓰세요.\n\n반드시 아래 JSON만 출력하세요.\n{"title":"사진 또는 확인 자료에서 읽은 정확한 책 제목","author":"사진 또는 확인 자료에서 읽은 저자·기획·출판사","questions":[{"question":"문제","options":["선택지1","선택지2","선택지3","선택지4"],"answer":0,"hint":"정답을 직접 밝히지 않는 힌트","skill":"확인 능력","explanation":"정답 설명"}]}`;

    const result = await callGemini({ apiKey, model, prompt, images: safeImages, maxOutputTokens: questionCount === 10 ? 5600 : 3400, temperature: 0.15 });
    const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const parsed = extractJson(text);
    if (parsed.error) return send(res, 422, { message: parsed.error, matchedBook: book });
    const quiz = validateQuiz(parsed, questionCount);
    const resolvedTitle = safeImages.length && parsed.title?.trim() ? parsed.title.trim() : book.title;
    const resolvedAuthor = safeImages.length && parsed.author?.trim() ? parsed.author.trim() : book.author;
    return send(res, 200, { ...quiz, title: resolvedTitle, author: resolvedAuthor, grade, matchedBook: { ...book, title: resolvedTitle, author: resolvedAuthor }, model, usedPhotos: safeImages.length });
  } catch (error) {
    console.error('quiz generation error', error);
    const message = error.message || '퀴즈 생성 중 오류가 발생했습니다.';
    if (/high demand|overloaded|temporarily unavailable/i.test(message)) return send(res, 503, { message: '지금 퀴즈 요청이 많아 잠시 혼잡합니다. 잠시 후 다시 시도해 주세요.' });
    if (/quota exceeded|rate limit|resource_exhausted/i.test(message)) return send(res, 429, { message: '잠시 동안 퀴즈 요청이 많았습니다. 10초 정도 후 다시 시도해 주세요.' });
    if (/문제 수가 올바르지 않습니다/.test(message)) return send(res, 422, { message: '문제 형식이 정확히 만들어지지 않았습니다. 같은 내용으로 다시 한 번 시도해 주세요.' });
    return send(res, 500, { message });
  }
}
