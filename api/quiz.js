const ALLOWED_COUNTS = new Set([3, 5, 10]);
const MAX_IMAGES = 3;

function send(res, status, payload) {
  res.status(status).json(payload);
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  if (!cleaned) throw new Error('AI 응답이 비어 있습니다.');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('AI 응답에서 JSON 형식을 찾지 못했습니다.');
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function normalizeText(value = '') {
  return String(value).toLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
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

function quizSchema(expectedCount) {
  return {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      author: { type: 'STRING' },
      questions: {
        type: 'ARRAY',
        minItems: expectedCount,
        maxItems: expectedCount,
        items: {
          type: 'OBJECT',
          properties: {
            question: { type: 'STRING' },
            options: { type: 'ARRAY', minItems: 4, maxItems: 4, items: { type: 'STRING' } },
            answer: { type: 'INTEGER', minimum: 0, maximum: 3 },
            hint: { type: 'STRING' },
            skill: { type: 'STRING' },
            explanation: { type: 'STRING' },
            evidence: { type: 'STRING' },
          },
          required: ['question', 'options', 'answer', 'hint', 'skill', 'explanation', 'evidence'],
        },
      },
    },
    required: ['title', 'author', 'questions'],
  };
}

function validateQuiz(data, expectedCount) {
  if (!data || !Array.isArray(data.questions) || data.questions.length !== expectedCount) {
    throw new Error('문제 수가 올바르지 않습니다.');
  }
  const seen = [];
  data.questions.forEach((item) => {
    if (!item.question || !Array.isArray(item.options) || item.options.length !== 4) {
      throw new Error('문제 형식이 올바르지 않습니다.');
    }
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3 || !item.options[item.answer]) {
      throw new Error('정답 형식이 올바르지 않습니다.');
    }
    if (!item.evidence || item.evidence.trim().length < 8) {
      throw new Error('문제 근거가 부족합니다.');
    }
    if (seen.some((question) => similarity(question, item.question) >= 0.82)) {
      throw new Error('비슷한 문제가 반복되었습니다.');
    }
    seen.push(item.question);
    item.hint ||= '책의 내용을 다시 떠올려 보세요.';
    item.explanation ||= item.evidence;
    item.skill ||= '내용 이해';
  });
  return data;
}

function geminiModel() {
  return process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
}

function kimiModel() {
  return process.env.KIMI_MODEL || 'kimi-k2.5';
}

function parseImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'),
      data: match[2],
    },
  };
}

async function callGemini({ apiKey, model, prompt, images = [], maxOutputTokens = 128, temperature = 0, googleSearch = false, schema = null }) {
  const generationConfig = { temperature, maxOutputTokens };
  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = schema;
  }
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map(parseImage).filter(Boolean)] }],
    generationConfig,
  };
  if (googleSearch) body.tools = [{ google_search: {} }];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `Gemini API 요청에 실패했습니다. (${response.status})`);
  return result;
}

function geminiText(result) {
  return result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
}

async function callKimi({ apiKey, model, prompt, maxTokens, temperature = 0.05 }) {
  const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: '당신은 초등학교 독서 퀴즈를 만드는 교사입니다. 반드시 제공된 자료만 사용하고, 응답은 유효한 JSON 객체 하나만 출력합니다.',
        },
        { role: 'user', content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `Kimi API 요청에 실패했습니다. (${response.status})`);
  return result?.choices?.[0]?.message?.content || '';
}

function scoreCandidate(candidate, title, identity) {
  const creators = [...candidate.authors, candidate.publisher].filter(Boolean).join(' ');
  return Math.min(1, similarity(title, candidate.title) * 0.84 + (identity ? similarity(identity, creators) : 0.5) * 0.16);
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
    if (!unique.has(key) || candidate.score > unique.get(key).score) unique.set(key, candidate);
  });
  return [...unique.values()].sort((a, b) => b.score - a.score)[0] || null;
}

async function searchOpenLibrary(title, identity) {
  try {
    const query = new URLSearchParams({ title, limit: '10', fields: 'key,title,author_name,publisher,first_publish_year,subject,isbn' });
    const response = await fetch(`https://openlibrary.org/search.json?${query.toString()}`);
    if (!response.ok) return null;
    const result = await response.json();
    return (result.docs || [])
      .map((doc) => ({
        title: doc.title || '',
        authors: doc.author_name || [],
        publisher: doc.publisher?.[0] || '',
        publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
        categories: (doc.subject || []).slice(0, 12),
        isbn: doc.isbn?.[0] || '',
        description: '',
        score: scoreCandidate(
          { title: doc.title || '', authors: doc.author_name || [], publisher: doc.publisher?.[0] || '' },
          title,
          identity,
        ),
      }))
      .sort((a, b) => b.score - a.score)[0] || null;
  } catch {
    return null;
  }
}

async function identifyBookFromCover({ apiKey, model, coverImage, manualTitle, manualIdentity }) {
  const prompt = `이 이미지는 책의 앞표지입니다. 책 식별 정보만 정확히 읽으세요.\n사용자 입력 제목: ${manualTitle || '없음'}\n사용자 입력 저자·출판사: ${manualIdentity || '없음'}\n보이지 않는 정보는 추측하지 마세요.`;
  const schema = {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      author: { type: 'STRING' },
      illustrator: { type: 'STRING' },
      publisher: { type: 'STRING' },
      series: { type: 'STRING' },
      volume: { type: 'STRING' },
      confidence: { type: 'NUMBER', minimum: 0, maximum: 1 },
    },
    required: ['title', 'author', 'illustrator', 'publisher', 'series', 'volume', 'confidence'],
  };
  const result = await callGemini({ apiKey, model, prompt, images: [coverImage], maxOutputTokens: 700, schema });
  const identified = extractJson(geminiText(result));
  if (!identified?.title || (identified.confidence ?? 0) < 0.5) {
    throw new Error('앞표지에서 책 제목을 정확히 읽지 못했습니다.');
  }
  return identified;
}

async function resolveIdentifiedBook(identified) {
  const identity = identified.author || identified.publisher || '';
  const [googleMatch, openLibraryMatch] = await Promise.all([
    searchGoogleBooks(identified.title, identity),
    searchOpenLibrary(identified.title, identity),
  ]);
  const match = [googleMatch, openLibraryMatch]
    .filter(Boolean)
    .filter((item) => similarity(identified.title, item.title) >= 0.72)
    .sort((a, b) => b.score - a.score)[0] || null;
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

async function researchBook({ apiKey, model, book }) {
  const prompt = `Google 검색으로 아래 책을 정확히 조사하세요. 같은 제목의 다른 책이나 같은 시리즈의 다른 권을 섞지 마세요.\n제목: ${book.title}\n저자: ${book.author}\n출판사: ${book.publisher || '알 수 없음'}\nISBN: ${book.isbn || '알 수 없음'}\n출판사, 서점, 도서관의 소개를 우선 사용하세요. 실제 내용, 등장인물, 배경, 사건, 핵심 메시지 중 확인된 사실만 적고 모르는 세부 내용은 만들지 마세요. JSON만 출력하세요.\n{"matched":true,"summary":"검증된 내용 요약","facts":["검증된 사실"],"confidence":0.0}`;
  const result = await callGemini({ apiKey, model, prompt, maxOutputTokens: 2600, googleSearch: true });
  const research = extractJson(geminiText(result));
  if (!research.matched || !Array.isArray(research.facts)) return { summary: '', facts: [], confidence: 0 };
  return {
    summary: String(research.summary || '').slice(0, 5000),
    facts: research.facts.map(String).filter(Boolean).slice(0, 35),
    confidence: Number(research.confidence || 0),
  };
}

async function extractSupportFacts({ apiKey, model, images, book }) {
  if (!images.length) return { summary: '', facts: [], confidence: 0 };
  const prompt = `아래 사진은 '${book.title}' 책의 뒷표지, 목차 또는 본문입니다. 사진에서 직접 확인되는 내용만 정리하세요. 보이지 않는 내용은 추측하지 마세요. JSON만 출력하세요.\n{"summary":"사진에서 확인한 내용 요약","facts":["사진에서 직접 확인되는 사실"],"confidence":0.0}`;
  const result = await callGemini({ apiKey, model, prompt, images, maxOutputTokens: 2200, temperature: 0, schema: {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      facts: { type: 'ARRAY', items: { type: 'STRING' } },
      confidence: { type: 'NUMBER', minimum: 0, maximum: 1 },
    },
    required: ['summary', 'facts', 'confidence'],
  } });
  const data = extractJson(geminiText(result));
  return {
    summary: String(data.summary || '').slice(0, 4000),
    facts: Array.isArray(data.facts) ? data.facts.map(String).filter(Boolean).slice(0, 30) : [],
    confidence: Number(data.confidence || 0),
  };
}

function buildQuizPrompt({ reference, grade, questionCount, title, author }) {
  return `아래 참고 자료만 사용하여 독서 퀴즈를 만드세요. 자료에 없는 인물, 사건, 장소, 숫자, 대사, 세부 장면은 절대 만들지 마세요.\n\n<참고자료>\n${reference}\n</참고자료>\n\n대상: ${grade}\n책 제목: ${title}\n저자: ${author}\n문제 수: ${questionCount}\n\n규칙:\n1. 초등학교 1학년이 읽기 쉬운 짧은 문장으로 씁니다.\n2. 각 문제의 선택지는 정확히 4개이며 정답은 하나입니다.\n3. 제목, 저자, 출판사, 표지 색깔이나 모양을 묻지 않습니다.\n4. 실제 내용, 인물의 행동, 원인과 결과, 핵심 메시지를 고르게 묻습니다.\n5. 비슷한 문제를 반복하지 않습니다.\n6. evidence에는 참고 자료에서 확인되는 근거 사실을 한 문장으로 씁니다.\n7. 정답은 options 배열의 0부터 3까지 위치 번호입니다.\n8. 반드시 다음 구조의 유효한 JSON 객체 하나만 출력합니다.\n{"title":"책 제목","author":"저자","questions":[{"question":"문제","options":["보기1","보기2","보기3","보기4"],"answer":0,"hint":"힌트","skill":"내용 이해","explanation":"정답 설명","evidence":"근거 문장"}]}`;
}

async function generateWithKimi({ apiKey, model, prompt, questionCount }) {
  const maxTokens = questionCount === 10 ? 6000 : questionCount === 5 ? 3600 : 2400;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const attemptPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\n이전 응답의 형식 또는 문제 품질이 올바르지 않았습니다. 문제 수, 4개 선택지, answer 숫자, evidence를 다시 확인하고 JSON 객체만 출력하세요.`;
      const text = await callKimi({ apiKey, model, prompt: attemptPrompt, maxTokens, temperature: attempt === 0 ? 0.05 : 0 });
      return validateQuiz(extractJson(text), questionCount);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Kimi 문제 생성에 실패했습니다.');
}

async function generateWithGemini({ apiKey, model, prompt, questionCount }) {
  const result = await callGemini({
    apiKey,
    model,
    prompt,
    maxOutputTokens: questionCount === 10 ? 6200 : questionCount === 5 ? 3800 : 2500,
    temperature: 0.05,
    schema: quizSchema(questionCount),
  });
  return validateQuiz(extractJson(geminiText(result)), questionCount);
}

export default async function handler(req, res) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const kimiApiKey = process.env.KIMI_API_KEY;
  const gModel = geminiModel();
  const kModel = kimiModel();

  if (req.method === 'GET' && req.query?.health === '1') {
    return send(res, 200, {
      ok: Boolean(geminiApiKey && kimiApiKey),
      geminiConfigured: Boolean(geminiApiKey),
      kimiConfigured: Boolean(kimiApiKey),
      geminiModel: gModel,
      kimiModel: kModel,
    });
  }
  if (req.method !== 'POST') return send(res, 405, { message: 'POST 요청만 사용할 수 있습니다.' });

  const { grade, title = '', author = '', count, images = [] } = req.body || {};
  const questionCount = Number(count);
  const safeImages = Array.isArray(images) ? images.slice(0, MAX_IMAGES).filter((image) => parseImage(image)) : [];
  if (!grade || !ALLOWED_COUNTS.has(questionCount)) return send(res, 400, { message: '학년과 문제 수를 확인해 주세요.' });
  if (!safeImages.length) return send(res, 400, { message: '책 앞표지 사진을 먼저 촬영해 주세요.' });
  if (!geminiApiKey) return send(res, 503, { message: 'Vercel 환경변수에 GEMINI_API_KEY를 등록해 주세요.' });

  try {
    const coverImage = safeImages[0];
    const supportImages = safeImages.slice(1);
    const identified = await identifyBookFromCover({
      apiKey: geminiApiKey,
      model: gModel,
      coverImage,
      manualTitle: title.trim(),
      manualIdentity: author.trim(),
    });
    const book = await resolveIdentifiedBook(identified);
    const [research, support] = await Promise.all([
      researchBook({ apiKey: geminiApiKey, model: gModel, book }),
      extractSupportFacts({ apiKey: geminiApiKey, model: gModel, images: supportImages, book }),
    ]);

    const hasCatalogContent = Boolean(book.description && book.description.length >= 80);
    const hasResearch = research.confidence >= 0.5 && research.facts.length >= 3;
    const hasSupport = support.confidence >= 0.5 && support.facts.length >= 2;
    const reference = [
      `책 제목: ${book.title}`,
      `저자: ${book.author}`,
      book.publisher ? `출판사: ${book.publisher}` : '',
      hasCatalogContent ? `공개 도서 소개: ${book.description}` : '',
      hasResearch ? `검색으로 검증한 내용 요약: ${research.summary}` : '',
      hasResearch ? `검색으로 검증한 사실:\n- ${research.facts.join('\n- ')}` : '',
      hasSupport ? `사용자 사진에서 확인한 내용: ${support.summary}` : '',
      hasSupport ? `사용자 사진에서 확인한 사실:\n- ${support.facts.join('\n- ')}` : '',
    ].filter(Boolean).join('\n\n');

    if (!hasCatalogContent && !hasResearch && !hasSupport) {
      return send(res, 422, {
        message: '책은 확인했지만 정확한 문제를 만들 자료가 부족합니다. 뒷표지나 본문 사진을 추가해 주세요.',
        matchedBook: book,
      });
    }

    const prompt = buildQuizPrompt({ reference, grade, questionCount, title: book.title, author: book.author });
    let quiz;
    let provider = 'kimi';
    let generationModel = kModel;
    let kimiError = '';

    if (kimiApiKey) {
      try {
        quiz = await generateWithKimi({ apiKey: kimiApiKey, model: kModel, prompt, questionCount });
      } catch (error) {
        kimiError = error.message || 'Kimi 생성 실패';
        console.warn('Kimi generation failed; falling back to Gemini', error);
      }
    }

    if (!quiz) {
      provider = 'gemini_fallback';
      generationModel = gModel;
      quiz = await generateWithGemini({ apiKey: geminiApiKey, model: gModel, prompt, questionCount });
    }

    return send(res, 200, {
      ...quiz,
      title: book.title,
      author: book.author,
      grade,
      matchedBook: book,
      provider,
      model: generationModel,
      researchModel: gModel,
      usedPhotos: safeImages.length,
      contentSource: hasSupport ? 'support_photos_and_search' : hasResearch ? 'google_search' : 'catalog',
      researchConfidence: research.confidence,
      kimiFallbackReason: provider === 'gemini_fallback' ? kimiError : undefined,
    });
  } catch (error) {
    console.error('quiz generation error', error);
    const message = error.message || '퀴즈 생성 중 오류가 발생했습니다.';
    if (/high demand|overloaded|temporarily unavailable/i.test(message)) {
      return send(res, 503, { message: '지금 퀴즈 요청이 많아 잠시 혼잡합니다. 잠시 후 다시 시도해 주세요.' });
    }
    if (/quota exceeded|rate limit|resource_exhausted|insufficient balance/i.test(message)) {
      return send(res, 429, { message: 'AI API 사용 한도 또는 잔액을 확인해 주세요.' });
    }
    if (/문제 수가 올바르지|비슷한 문제가 반복|문제 근거가 부족|문제 형식이 올바르지/.test(message)) {
      return send(res, 422, { message: '정확한 문제 세트를 만들지 못했습니다. 다시 시도하거나 본문 사진을 추가해 주세요.' });
    }
    return send(res, 500, { message });
  }
}
