const ALLOWED_COUNTS = new Set([3, 5, 10]);

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
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '');
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
    if (!item.hint) item.hint = '문제가 묻는 인물이나 장면을 책에서 다시 떠올려 보세요.';
    if (!item.explanation) item.explanation = '책의 해당 장면을 다시 떠올려 보세요.';
    if (!item.skill) item.skill = '내용 이해';
  });
  return data;
}

function normalizeModel(value) {
  let model = (value || 'gemini-3.5-flash').trim();
  if (model.startsWith('emini-')) model = `g${model}`;
  if (['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'].includes(model)) model = 'gemini-3.5-flash';
  return model;
}

async function callGemini({ apiKey, model, prompt, maxOutputTokens = 128, temperature = 0 }) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens },
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message || 'Gemini API 요청에 실패했습니다.');
  return result;
}

async function searchGoogleBooks(title, author) {
  const query = [title, author].filter(Boolean).join(' ');
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&printType=books`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const result = await response.json();
  const candidates = (result.items || []).map((item) => {
    const info = item.volumeInfo || {};
    const creators = [...(info.authors || []), info.publisher].filter(Boolean).join(' ');
    const titleScore = similarity(title, info.title || '');
    const creatorScore = author ? similarity(author, creators) : 0.5;
    const score = titleScore * 0.78 + creatorScore * 0.22;
    return {
      score,
      title: info.title || title,
      authors: info.authors || [],
      publisher: info.publisher || '',
      publishedDate: info.publishedDate || '',
      description: (info.description || '').replace(/<[^>]+>/g, ' ').slice(0, 3500),
      categories: info.categories || [],
      isbn: (info.industryIdentifiers || []).find((item) => item.type === 'ISBN_13')?.identifier || '',
    };
  }).sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function correctBookInput({ apiKey, model, title, author }) {
  const prompt = `사용자가 한국어로 책 정보를 입력했습니다. 오타, 띄어쓰기 오류, 외국인 이름의 표기 차이가 있을 수 있습니다. 실제 책을 확실히 식별할 수 있을 때만 교정하세요. 추측하지 마세요.\n입력 제목: ${title}\n입력 저자·옮긴이·출판사: ${author}\n\nJSON만 출력하세요.\n{"title":"교정된 실제 제목 또는 입력 제목","author":"교정된 저자·옮긴이·출판사 또는 입력값","confidence":0.0}`;
  const result = await callGemini({ apiKey, model, prompt, maxOutputTokens: 180, temperature: 0 });
  const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  return extractJson(text);
}

async function resolveBook({ apiKey, model, title, author }) {
  let match = await searchGoogleBooks(title, author);
  let corrected = null;

  if (!match || match.score < 0.58) {
    try {
      corrected = await correctBookInput({ apiKey, model, title, author });
      if (corrected?.confidence >= 0.65) {
        const correctedMatch = await searchGoogleBooks(corrected.title, corrected.author);
        if (correctedMatch && (!match || correctedMatch.score > match.score)) match = correctedMatch;
      }
    } catch {
      corrected = null;
    }
  }

  if (match && match.score >= 0.48) {
    return {
      title: match.title,
      author: match.authors.join(', ') || match.publisher || author,
      publisher: match.publisher,
      publishedDate: match.publishedDate,
      description: match.description,
      categories: match.categories,
      isbn: match.isbn,
      confidence: match.score,
      corrected: normalizeText(match.title) !== normalizeText(title) || similarity(author, `${match.authors.join(' ')} ${match.publisher}`) < 0.9,
      originalTitle: title,
      originalAuthor: author,
    };
  }

  return {
    title: corrected?.confidence >= 0.65 ? corrected.title : title,
    author: corrected?.confidence >= 0.65 ? corrected.author : author,
    publisher: '',
    publishedDate: '',
    description: '',
    categories: [],
    isbn: '',
    confidence: corrected?.confidence || 0,
    corrected: Boolean(corrected?.confidence >= 0.65),
    originalTitle: title,
    originalAuthor: author,
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = normalizeModel(process.env.GEMINI_QUIZ_MODEL);

  if (req.method === 'GET' && req.query?.models === '1') {
    if (!apiKey) return send(res, 503, { ok: false, configured: false, message: 'GEMINI_API_KEY가 없습니다.' });
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || '모델 목록 조회에 실패했습니다.');
      const models = (result.models || [])
        .filter((item) => item.supportedGenerationMethods?.includes('generateContent'))
        .map((item) => item.name?.replace(/^models\//, ''))
        .filter((name) => name?.includes('flash'));
      return send(res, 200, { ok: true, models });
    } catch (error) {
      return send(res, 502, { ok: false, message: error.message });
    }
  }

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

  const { grade, title, author, count } = req.body || {};
  const questionCount = Number(count);
  if (!grade || !title?.trim() || !author?.trim() || !ALLOWED_COUNTS.has(questionCount)) {
    return send(res, 400, { message: '학년, 책 이름, 저자·옮긴이·출판사, 문제 수를 확인해 주세요.' });
  }

  if (!apiKey) {
    return send(res, 503, { message: 'Vercel 환경변수에 GEMINI_API_KEY를 등록하면 퀴즈를 만들 수 있어요.' });
  }

  try {
    const book = await resolveBook({ apiKey, model, title: title.trim(), author: author.trim() });
    const reference = [
      `확인된 제목: ${book.title}`,
      `확인된 저자·출판사: ${book.author}${book.publisher ? ` / ${book.publisher}` : ''}`,
      book.publishedDate ? `출간 정보: ${book.publishedDate}` : '',
      book.isbn ? `ISBN: ${book.isbn}` : '',
      book.categories.length ? `분류: ${book.categories.join(', ')}` : '',
      book.description ? `공식 도서 설명: ${book.description}` : '공식 도서 설명을 찾지 못함',
    ].filter(Boolean).join('\n');

    const prompt = `당신은 한국 초등학생을 위한 정확한 독서퀴즈 출제자입니다.\n${reference}\n대상: ${grade}\n문제 수: ${questionCount}\n\n중요 규칙:\n1. 위에서 확인된 책 한 권만 다루세요. 비슷한 제목의 다른 책이나 영화, 애니메이션 내용을 섞지 마세요.\n2. 공식 도서 설명과 널리 확인되는 실제 내용에 근거한 문제만 만드세요. 확실하지 않은 세부 인물명, 물건, 대사, 사건은 출제하지 마세요.\n3. 책 내용을 충분히 확신할 수 없다면 문제를 지어내지 말고 JSON의 error에 “책 내용을 정확히 확인하기 어렵습니다. 책 표지의 ISBN이나 출판사를 추가해 주세요.”라고 적으세요.\n4. 등장인물, 사건, 배경, 원인과 결과, 핵심 메시지를 골고루 묻되 ${grade} 수준의 쉬운 한국어를 사용하세요.\n5. 선택지는 정확히 4개이며 정답은 0부터 3까지의 배열 인덱스입니다.\n6. 모호하거나 의견에 따라 답이 달라지는 문제, 제목만 보고 맞힐 수 있는 문제는 만들지 마세요.\n7. explanation은 책 내용에 따른 정답 근거를 한두 문장으로 설명하세요.\n8. hint는 정답을 직접 말하지 않고 장면이나 인물을 떠올리게 하는 한 문장으로 쓰세요.\n9. skill은 해당 문제가 확인하는 능력을 12자 이내로 쓰세요. 예: 인물 이해, 사건 순서, 원인과 결과, 핵심 주제, 세부 기억.\n10. 기존 문제를 재출제하는 상황일 수 있으므로 서로 다른 장면과 표현을 사용하세요.\n\n반드시 아래 JSON만 출력하세요.\n{\n  "title": "확인된 책 제목",\n  "author": "확인된 저자 또는 출판사",\n  "questions": [\n    {\n      "question": "문제",\n      "options": ["선택지1", "선택지2", "선택지3", "선택지4"],\n      "answer": 0,\n      "hint": "정답을 직접 밝히지 않는 힌트",\n      "skill": "확인 능력",\n      "explanation": "정답 설명"\n    }\n  ]\n}`;

    const result = await callGemini({
      apiKey,
      model,
      prompt,
      maxOutputTokens: questionCount === 10 ? 5600 : 3400,
      temperature: 0.25,
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
    });
  } catch (error) {
    console.error('quiz generation error', error);
    return send(res, 500, { message: error.message || '퀴즈 생성 중 오류가 발생했습니다.' });
  }
}
