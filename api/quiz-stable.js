const ALLOWED_COUNTS = new Set([3, 5, 10]);
const MAX_IMAGES = 3;
const FORBIDDEN_META = /(수상|상\s*이름|어떤\s*상|기법|제작\s*기법|표현\s*기법|그림\s*기법|재료|출판사|출간|발행|ISBN|작가의\s*경력|저자의\s*경력|문학상|선정도서|추천도서)/i;

function send(res, status, payload) { res.status(status).json(payload); }

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  if (!cleaned) throw new Error('AI_EMPTY_RESPONSE');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI_JSON_NOT_FOUND');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseImage(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  return { inlineData: { mimeType: m[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data: m[2] } };
}

function geminiText(result) {
  return result?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

async function callGemini({ apiKey, model, prompt, images = [], maxOutputTokens = 2048, temperature = 0, schema, googleSearch = false }) {
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
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `Gemini API 오류 (${response.status})`);
  return result;
}

async function geminiJsonWithRetry(args, retries = 2) {
  let lastError;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const result = await callGemini({ ...args, temperature: i === 0 ? (args.temperature ?? 0) : 0.1 });
      return extractJson(geminiText(result));
    } catch (error) {
      lastError = error;
      console.warn('Gemini JSON retry', i + 1, error.message);
    }
  }
  throw lastError;
}

async function callKimi({ apiKey, model, prompt, maxTokens }) {
  const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '당신은 초등학교 1학년 담임 교사입니다. 이야기 속 인물, 행동, 장소, 사건, 느낌만 묻습니다. 수상 경력, 출판 정보, 그림 제작 기법, 작가 경력은 절대 문제로 만들지 않습니다. 제공된 자료만 사용하고 유효한 JSON 객체 하나만 출력하세요.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.05,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || `Kimi API 오류 (${response.status})`);
  return result?.choices?.[0]?.message?.content || '';
}

async function identifyCover(apiKey, model, cover, title, author) {
  const schema = {
    type: 'OBJECT',
    properties: { title: { type: 'STRING' }, author: { type: 'STRING' }, publisher: { type: 'STRING' }, confidence: { type: 'NUMBER' } },
    required: ['title', 'author', 'publisher', 'confidence'],
  };
  const prompt = `책 앞표지 사진에서 제목과 저자, 출판사를 읽으세요. 보이지 않는 정보는 추측하지 마세요.\n사용자 입력 제목: ${title || '없음'}\n사용자 입력 저자: ${author || '없음'}`;
  try {
    return await geminiJsonWithRetry({ apiKey, model, prompt, images: [cover], maxOutputTokens: 600, schema }, 2);
  } catch (error) {
    if (title.trim()) return { title: title.trim(), author: author.trim(), publisher: '', confidence: 0.6 };
    throw error;
  }
}

async function googleBooks(title, author) {
  try {
    const q = [title, author].filter(Boolean).join(' ');
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10&printType=books`);
    if (!response.ok) return null;
    const data = await response.json();
    const item = (data.items || []).find((x) => String(x.volumeInfo?.title || '').includes(title)) || data.items?.[0];
    if (!item) return null;
    const v = item.volumeInfo || {};
    return {
      title: v.title || title,
      author: (v.authors || []).join(', ') || author,
      publisher: v.publisher || '',
      description: String(v.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      isbn: (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13')?.identifier || '',
    };
  } catch { return null; }
}

async function extractPhotoFacts(apiKey, model, images) {
  if (!images.length) return [];
  const schema = { type: 'OBJECT', properties: { facts: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['facts'] };
  try {
    const data = await geminiJsonWithRetry({
      apiKey, model,
      prompt: '이 사진들은 책의 뒷표지, 목차 또는 본문입니다. 초등학교 1학년이 이해할 수 있는 이야기 내용만 뽑으세요. 등장인물, 행동, 장소, 사건, 감정, 원인과 결과를 짧은 문장으로 정리하세요. 수상 정보, 출판 정보, 작가 경력, 그림 제작 기법은 제외하세요. 추측하지 마세요.',
      images, maxOutputTokens: 1800, schema,
    }, 1);
    return Array.isArray(data.facts) ? data.facts.map(String).filter((x) => x && !FORBIDDEN_META.test(x)).slice(0, 30) : [];
  } catch (error) {
    console.warn('support photo extraction skipped', error.message);
    return [];
  }
}

async function researchBook(apiKey, model, book) {
  const prompt = `Google 검색으로 다음 책을 조사하세요. 같은 제목의 다른 책을 섞지 마세요. 출판사, 서점, 도서관 소개를 우선하세요. 초등학교 1학년 독서 문제에 사용할 이야기 내용만 수집하세요. 등장인물, 장소, 행동, 사건의 순서, 원인과 결과, 감정, 핵심 메시지만 포함하고 수상 경력, 판매 기록, 출판 정보, 작가 이력, 그림 제작 기법은 facts에 넣지 마세요. JSON만 출력하세요.\n제목: ${book.title}\n저자: ${book.author}\n출판사: ${book.publisher || '알 수 없음'}\nISBN: ${book.isbn || '알 수 없음'}\n형식: {"summary":"초1이 이해할 수 있는 이야기 요약","facts":["이야기 속 사실"],"confidence":0.0}`;
  try {
    const result = await callGemini({ apiKey, model, prompt, maxOutputTokens: 2200, googleSearch: true });
    const data = extractJson(geminiText(result));
    const facts = Array.isArray(data.facts) ? data.facts.map(String).filter((x) => x && !FORBIDDEN_META.test(x)) : [];
    return { summary: String(data.summary || ''), facts, confidence: Number(data.confidence || 0) };
  } catch (error) {
    console.warn('book research skipped', error.message);
    return { summary: '', facts: [], confidence: 0 };
  }
}

function quizSchema(count) {
  return {
    type: 'OBJECT', properties: {
      title: { type: 'STRING' }, author: { type: 'STRING' },
      questions: { type: 'ARRAY', minItems: count, maxItems: count, items: { type: 'OBJECT', properties: {
        question: { type: 'STRING' }, options: { type: 'ARRAY', minItems: 4, maxItems: 4, items: { type: 'STRING' } },
        answer: { type: 'INTEGER' }, hint: { type: 'STRING' }, skill: { type: 'STRING' }, explanation: { type: 'STRING' }, evidence: { type: 'STRING' },
      }, required: ['question','options','answer','hint','skill','explanation','evidence'] } },
    }, required: ['title','author','questions'],
  };
}

function validateQuiz(data, count) {
  if (!Array.isArray(data?.questions) || data.questions.length !== count) throw new Error('문제 수가 올바르지 않습니다.');
  const seen = new Set();
  for (const item of data.questions) {
    if (!item.question || !Array.isArray(item.options) || item.options.length !== 4) throw new Error('문제 형식이 올바르지 않습니다.');
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) throw new Error('정답 형식이 올바르지 않습니다.');
    if (!item.evidence) throw new Error('문제 근거가 부족합니다.');
    if (FORBIDDEN_META.test(`${item.question} ${item.options.join(' ')} ${item.explanation || ''}`)) throw new Error('초1에게 어려운 책 바깥 정보가 포함되었습니다.');
    if (String(item.question).length > 45) throw new Error('초1에게 질문 문장이 너무 깁니다.');
    if (item.options.some((option) => String(option).length > 22)) throw new Error('초1에게 보기가 너무 깁니다.');
    const key = item.question.replace(/\s/g, '');
    if (seen.has(key)) throw new Error('비슷한 문제가 반복되었습니다.');
    seen.add(key);
  }
  return data;
}

export default async function handler(req, res) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const kimiKey = process.env.KIMI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const kimiModel = process.env.KIMI_MODEL || 'kimi-k2.5';

  if (req.method === 'GET') return send(res, 200, { ok: true, geminiConfigured: Boolean(geminiKey), kimiConfigured: Boolean(kimiKey), geminiModel, kimiModel });
  if (req.method !== 'POST') return send(res, 405, { message: 'POST 요청만 사용할 수 있습니다.' });

  const { grade, title = '', author = '', count, images = [] } = req.body || {};
  const questionCount = Number(count);
  const safeImages = Array.isArray(images) ? images.slice(0, MAX_IMAGES).filter(parseImage) : [];
  if (!grade || !ALLOWED_COUNTS.has(questionCount)) return send(res, 400, { message: '학년과 문제 수를 확인해 주세요.' });
  if (!safeImages.length) return send(res, 400, { message: '책 앞표지 사진을 먼저 촬영해 주세요.' });
  if (!geminiKey) return send(res, 503, { message: 'GEMINI_API_KEY가 없습니다.' });

  try {
    const identified = await identifyCover(geminiKey, geminiModel, safeImages[0], title, author);
    const catalog = await googleBooks(identified.title, identified.author);
    const book = { title: catalog?.title || identified.title, author: catalog?.author || identified.author || author || '저자 정보 없음', publisher: catalog?.publisher || identified.publisher || '', description: catalog?.description || '', isbn: catalog?.isbn || '' };
    const [research, photoFacts] = await Promise.all([
      researchBook(geminiKey, geminiModel, book),
      extractPhotoFacts(geminiKey, geminiModel, safeImages.slice(1)),
    ]);
    const facts = [...research.facts, ...photoFacts].filter((x) => x && !FORBIDDEN_META.test(x));
    const reference = [`제목: ${book.title}`, `저자: ${book.author}`, book.description ? `공개 책 소개: ${book.description}` : '', research.summary ? `검색 요약: ${research.summary}` : '', facts.length ? `확인된 이야기 사실:\n- ${facts.join('\n- ')}` : ''].filter(Boolean).join('\n\n');
    if (!book.description && facts.length < 3) return send(res, 422, { message: '정확한 내용 문제가 될 자료가 부족합니다. 뒷표지나 본문 사진을 추가해 주세요.', matchedBook: book });

    const prompt = `다음 자료만 사용하여 ${grade} 수준 독서 퀴즈 ${questionCount}개를 만드세요. 특히 초등학교 1학년이 혼자 읽고 답할 수 있어야 합니다.\n\n반드시 지킬 규칙:\n1. 이야기 안에서 직접 확인되는 인물, 장소, 행동, 사건의 순서, 기분, 쉬운 원인과 결과만 묻습니다.\n2. 수상 경력, 상 이름, 출판사, 출간 연도, 작가 경력, 그림 재료나 제작 기법, 판매 기록은 절대 묻지 않습니다.\n3. 제목·저자·표지 모양을 묻지 않습니다.\n4. 질문은 한 문장, 45자 이내로 씁니다. 어려운 한자어와 전문 용어를 쓰지 않습니다.\n5. 보기 하나는 22자 이내이며 정확히 4개입니다. 정답은 0부터 3 사이 인덱스입니다.\n6. 문제 구성은 쉬운 사실 확인 약 70%, 인물의 기분이나 쉬운 까닭 약 30%로 합니다.\n7. 책을 읽지 않은 어른의 배경지식이 필요한 문제는 만들지 않습니다.\n8. 각 문제 evidence에는 이야기 자료에서 확인되는 근거를 씁니다.\n9. 자료에 없는 사실은 추측하지 않습니다.\n\n${reference}\n\nJSON 형식: {"title":"책 제목","author":"저자","questions":[{"question":"질문","options":["보기1","보기2","보기3","보기4"],"answer":0,"hint":"짧은 힌트","skill":"내용 이해","explanation":"쉬운 설명","evidence":"근거"}]}`;

    let quiz;
    let provider = 'kimi';
    if (kimiKey) {
      try {
        const text = await callKimi({ apiKey: kimiKey, model: kimiModel, prompt, maxTokens: questionCount === 10 ? 6000 : 3600 });
        quiz = validateQuiz(extractJson(text), questionCount);
      } catch (error) {
        console.warn('Kimi generation failed; falling back to Gemini', error.message);
      }
    }
    if (!quiz) {
      provider = 'gemini_fallback';
      const data = await geminiJsonWithRetry({ apiKey: geminiKey, model: geminiModel, prompt, maxOutputTokens: questionCount === 10 ? 6000 : 3600, schema: quizSchema(questionCount), temperature: 0.05 }, 2);
      quiz = validateQuiz(data, questionCount);
    }
    return send(res, 200, { ...quiz, title: book.title, author: book.author, grade, provider, model: provider === 'kimi' ? kimiModel : geminiModel, matchedBook: book, usedPhotos: safeImages.length });
  } catch (error) {
    console.error('stable quiz generation error', error);
    const message = error.message || '퀴즈 생성 중 오류가 발생했습니다.';
    if (/insufficient balance|suspended|recharge/i.test(message)) return send(res, 402, { message: 'Kimi 결제 잔액 또는 API 키가 아직 활성화되지 않았습니다. Moonshot 결제 계정과 API 키의 조직이 같은지 확인해 주세요.' });
    if (/quota|rate limit|resource_exhausted/i.test(message)) return send(res, 429, { message: 'API 사용 한도를 확인해 주세요.' });
    if (/초1에게 어려운|질문 문장이 너무|보기가 너무/.test(message)) return send(res, 422, { message: '초등학교 1학년에게 알맞지 않은 문제가 포함되어 자동으로 제외했습니다. 다시 만들기를 눌러 주세요.' });
    if (/AI_EMPTY_RESPONSE|AI_JSON_NOT_FOUND|JSON/.test(message)) return send(res, 502, { message: 'AI가 올바른 형식으로 응답하지 않았습니다. 자동 재시도 후에도 실패했습니다.' });
    return send(res, 500, { message });
  }
}
