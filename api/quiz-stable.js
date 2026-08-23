const ALLOWED_COUNTS = new Set([3, 5, 10]);
const MAX_IMAGES = 3;
const FORBIDDEN_META = /(수상|상\s*이름|어떤\s*상|기법|제작\s*기법|표현\s*기법|그림\s*기법|출판사|출간|발행|ISBN|작가의\s*경력|저자의\s*경력|문학상|선정도서|추천도서)/i;

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
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  return { inlineData: { mimeType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), data: match[2] } };
}

function geminiText(result) {
  return result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
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
  for (let index = 0; index <= retries; index += 1) {
    try {
      const result = await callGemini({ ...args, temperature: index === 0 ? (args.temperature ?? 0) : 0.1 });
      return extractJson(geminiText(result));
    } catch (error) {
      lastError = error;
      console.warn('Gemini JSON retry', index + 1, error.message);
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
        { role: 'system', content: '당신은 초등학교 독서 퀴즈 교사입니다. 단순 암기보다 이야기의 문맥 이해를 우선합니다. 사건의 앞뒤 관계, 원인과 결과, 인물의 행동 이유, 상황에 따른 마음, 사건끼리의 연결을 묻는 문제를 많이 만듭니다. 학년 수준은 가능한 한 맞추되, 근거가 분명한 좋은 문맥 이해 문제라면 조금 어려워도 출제합니다. 단, 자료에 없는 내용은 추측하지 않습니다. 10문제일 때 마지막 문제는 정답이 없는 생각 쓰기 문제로 만듭니다. 수상 경력, 출판 정보, 그림 제작 기법, 작가 경력은 문제로 만들지 않습니다. 제공된 자료만 사용하고 유효한 JSON 객체 하나만 출력하세요.' },
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

async function identifyCover(apiKey, model, cover, title = '', author = '') {
  const schema = {
    type: 'OBJECT',
    properties: { title: { type: 'STRING' }, author: { type: 'STRING' }, publisher: { type: 'STRING' }, confidence: { type: 'NUMBER' } },
    required: ['title', 'author', 'publisher', 'confidence'],
  };
  const prompt = `책 앞표지 사진에서 제목과 글쓴이, 출판사를 읽으세요. 보이지 않는 정보는 추측하지 마세요.\n사용자 입력 제목: ${title || '없음'}\n사용자 입력 글쓴이: ${author || '없음'}`;
  return geminiJsonWithRetry({ apiKey, model, prompt, images: [cover], maxOutputTokens: 600, schema }, 2);
}

async function googleBooks(title, people, publisher) {
  try {
    const query = [title, people, publisher].filter(Boolean).join(' ');
    const response = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10&printType=books`);
    if (!response.ok) return null;
    const data = await response.json();
    const normalized = String(title).replace(/\s/g, '');
    const item = (data.items || []).find((entry) => String(entry.volumeInfo?.title || '').replace(/\s/g, '').includes(normalized)) || data.items?.[0];
    if (!item) return null;
    const info = item.volumeInfo || {};
    return {
      title: info.title || title,
      author: (info.authors || []).join(', ') || people,
      publisher: info.publisher || publisher || '',
      description: String(info.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      isbn: (info.industryIdentifiers || []).find((entry) => entry.type === 'ISBN_13')?.identifier || '',
    };
  } catch { return null; }
}

async function extractPhotoFacts(apiKey, model, images) {
  if (!images.length) return [];
  const schema = { type: 'OBJECT', properties: { facts: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['facts'] };
  try {
    const data = await geminiJsonWithRetry({
      apiKey, model,
      prompt: '이 사진들은 책의 뒷표지, 목차 또는 본문입니다. 독서 문제에서 문맥을 묻기 좋도록 이야기 내용을 정리하세요. 등장인물과 행동만 나열하지 말고 사건의 앞뒤 순서, 행동의 이유, 원인과 결과, 인물의 감정이 바뀌는 계기, 문제와 해결, 사건끼리의 연결을 우선해 짧은 문장으로 뽑으세요. 초등학생이 이해할 수 있는 표현을 쓰고, 수상 정보, 출판 정보, 작가 경력, 그림 제작 기법은 제외하세요. 사진에서 확인되지 않는 내용은 추측하지 마세요.',
      images, maxOutputTokens: 1800, schema,
    }, 1);
    return Array.isArray(data.facts) ? data.facts.map(String).filter((fact) => fact && !FORBIDDEN_META.test(fact)).slice(0, 30) : [];
  } catch (error) {
    console.warn('support photo extraction skipped', error.message);
    return [];
  }
}

async function researchBook(apiKey, model, book) {
  const prompt = `Google 검색으로 다음 책을 조사하세요. 같은 제목의 다른 책을 섞지 마세요. 입력한 글쓴이·그림 작가·옮긴이·출판사와 일치하는 자료를 우선하세요. 초등 독서 문제에 사용할 이야기 내용만 수집하세요. 특히 문맥 파악 문제를 만들 수 있도록 사건의 순서, 원인과 결과, 인물이 그런 행동을 한 이유, 감정 변화의 계기, 문제와 해결, 앞 사건이 뒤 사건에 미친 영향, 이야기의 중심 상황을 우선 정리하세요. 단순한 인물 이름·장소 이름만 나열하는 facts는 최소화하세요. 수상 경력, 판매 기록, 출판 정보, 작가 이력, 그림 제작 기법은 facts에 넣지 마세요. JSON만 출력하세요.\n제목: ${book.title}\n글쓴이·그림·옮긴이: ${book.people || '알 수 없음'}\n출판사: ${book.publisher || '알 수 없음'}\nISBN: ${book.isbn || '알 수 없음'}\n형식: {"summary":"사건 흐름과 인물의 이유·감정 변화를 포함한 쉬운 이야기 요약","facts":["문맥 이해에 도움이 되는 이야기 사실"],"confidence":0.0}`;
  try {
    const result = await callGemini({ apiKey, model, prompt, maxOutputTokens: 2200, googleSearch: true });
    const data = extractJson(geminiText(result));
    const facts = Array.isArray(data.facts) ? data.facts.map(String).filter((fact) => fact && !FORBIDDEN_META.test(fact)) : [];
    return { summary: String(data.summary || ''), facts, confidence: Number(data.confidence || 0) };
  } catch (error) {
    console.warn('book research skipped', error.message);
    return { summary: '', facts: [], confidence: 0 };
  }
}

function quizSchema(count) {
  return {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      author: { type: 'STRING' },
      questions: {
        type: 'ARRAY', minItems: count, maxItems: count,
        items: {
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING' },
            question: { type: 'STRING' },
            options: { type: 'ARRAY', minItems: 0, maxItems: 4, items: { type: 'STRING' } },
            answer: { type: 'INTEGER' },
            hint: { type: 'STRING' },
            skill: { type: 'STRING' },
            explanation: { type: 'STRING' },
            evidence: { type: 'STRING' },
          },
          required: ['type', 'question', 'options', 'answer', 'hint', 'skill', 'explanation', 'evidence'],
        },
      },
    },
    required: ['title', 'author', 'questions'],
  };
}

function normalizeQuiz(data, count) {
  if (!Array.isArray(data?.questions) || data.questions.length !== count) throw new Error('문제 수가 올바르지 않습니다.');
  data.questions = data.questions.map((item, index) => {
    const shouldBeOpen = count === 10 && index === count - 1;
    return {
      ...item,
      type: shouldBeOpen ? 'open_ended' : 'multiple_choice',
      options: shouldBeOpen ? [] : item.options,
      answer: shouldBeOpen ? -1 : item.answer,
      skill: shouldBeOpen ? '생각 표현' : (item.skill || '문맥 이해'),
      hint: item.hint || '',
      explanation: item.explanation || item.evidence || '책의 이야기 흐름을 다시 떠올려 보세요.',
      evidence: item.evidence || item.explanation || '책의 이야기 내용에 근거한 문제입니다.',
    };
  });
  return data;
}

function validateQuiz(raw, count) {
  const data = normalizeQuiz(raw, count);
  for (let index = 0; index < data.questions.length; index += 1) {
    const item = data.questions[index];
    const openEnded = item.type === 'open_ended';
    if (!item.question) throw new Error('문제 형식이 올바르지 않습니다.');
    if (openEnded) {
      if (count !== 10 || index !== count - 1) throw new Error('서술형 문제 위치가 올바르지 않습니다.');
      item.options = [];
      item.answer = -1;
    } else {
      if (!Array.isArray(item.options) || item.options.length !== 4) throw new Error('객관식 문제 형식이 올바르지 않습니다.');
      if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) throw new Error('정답 형식이 올바르지 않습니다.');
    }
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
  if (!geminiKey) return send(res, 503, { message: 'GEMINI_API_KEY가 없습니다.' });

  const { action = 'generate', grade, title = '', author = '', illustrator = '', translator = '', publisher = '', count, images = [], imageRoles = [] } = req.body || {};
  const safeImages = Array.isArray(images) ? images.slice(0, MAX_IMAGES).filter(parseImage) : [];

  if (action === 'identify') {
    if (!safeImages.length) return send(res, 400, { message: '앞표지 사진을 먼저 추가해 주세요.' });
    try {
      return send(res, 200, await identifyCover(geminiKey, geminiModel, safeImages[0], title, author));
    } catch (error) {
      console.error('cover identification error', error);
      return send(res, 502, { message: '표지에서 책 정보를 읽지 못했습니다. 직접 입력해 주세요.' });
    }
  }

  const questionCount = Number(count);
  if (!grade || !ALLOWED_COUNTS.has(questionCount)) return send(res, 400, { message: '학년과 문제 수를 확인해 주세요.' });
  if (!String(title).trim()) return send(res, 400, { message: '책 제목을 입력해 주세요.' });

  try {
    const people = [author, illustrator && `그림 ${illustrator}`, translator && `옮김 ${translator}`].filter(Boolean).join(', ');
    const coverIndex = Array.isArray(imageRoles) ? imageRoles.indexOf('front_cover') : -1;
    let identified = { title: String(title).trim(), author: people, publisher: String(publisher).trim(), confidence: 1 };
    if (coverIndex >= 0 && safeImages[coverIndex]) {
      try {
        const fromCover = await identifyCover(geminiKey, geminiModel, safeImages[coverIndex], title, author);
        identified = { title: String(title).trim() || fromCover.title, author: people || fromCover.author, publisher: String(publisher).trim() || fromCover.publisher, confidence: fromCover.confidence };
      } catch (error) { console.warn('cover verification skipped', error.message); }
    }

    const catalog = await googleBooks(identified.title, identified.author, identified.publisher);
    const book = {
      title: String(title).trim() || catalog?.title || identified.title,
      author: author || catalog?.author || identified.author || '저자 정보 없음',
      people: people || catalog?.author || identified.author || '',
      publisher: publisher || catalog?.publisher || identified.publisher || '',
      description: catalog?.description || '',
      isbn: catalog?.isbn || '',
    };

    const supportImages = safeImages.filter((_, index) => imageRoles[index] !== 'front_cover');
    const [research, photoFacts] = await Promise.all([researchBook(geminiKey, geminiModel, book), extractPhotoFacts(geminiKey, geminiModel, supportImages)]);
    const facts = [...research.facts, ...photoFacts].filter((fact) => fact && !FORBIDDEN_META.test(fact));
    const reference = [
      `제목: ${book.title}`,
      book.people ? `글·그림·옮긴이: ${book.people}` : '',
      book.publisher ? `출판사: ${book.publisher}` : '',
      book.description ? `공개 책 소개: ${book.description}` : '',
      research.summary ? `검색 요약: ${research.summary}` : '',
      facts.length ? `확인된 이야기 사실:\n- ${facts.join('\n- ')}` : '',
    ].filter(Boolean).join('\n\n');

    const compositionRule = questionCount === 10
      ? '10문제는 반드시 1~9번 객관식, 10번 서술형으로 구성합니다. 1~9번 중 최소 6문제는 문맥 파악 문제로 만드세요. 문맥 파악 문제란 사건의 앞뒤 순서, 왜 그런 일이 일어났는지, 인물이 왜 그렇게 행동했는지, 상황 때문에 마음이 어떻게 달라졌는지, 한 사건이 다음 사건과 어떻게 이어지는지, 문제 상황이 어떻게 해결되는지를 묻는 문제입니다. 단순히 이름·장소·물건 하나를 기억하는 문제는 2문제 이하로 제한합니다. 10번은 정답이 없는 생각 쓰기 문제이며, 책을 읽고 느낀 점, 인물에게 해 주고 싶은 말, 내가 같은 상황이라면 어떻게 할지, 내 경험과 연결하기 중 책에 가장 알맞은 한 가지를 묻습니다. 10번의 type은 open_ended, options는 [], answer는 -1로 씁니다.'
      : `${questionCount}문제는 모두 객관식으로 만들고 type은 multiple_choice로 씁니다. 전체의 절반 이상은 문맥 파악 문제로 만드세요. 문맥 파악은 사건 순서, 원인과 결과, 행동 이유, 상황에 따른 감정, 사건끼리의 연결을 묻는 것입니다. 단순 이름·장소·물건 기억 문제는 최소화합니다.`;

    const prompt = `다음 자료를 바탕으로 ${grade} 수준 독서 퀴즈 ${questionCount}개를 만드세요. 목표는 아이가 책의 낱개 사실을 외웠는지가 아니라 이야기의 흐름과 문맥을 이해했는지 확인하는 것입니다. 학년 수준은 가능한 한 맞추되, 근거가 분명하고 문맥 이해에 도움이 되는 문제라면 조금 어려워도 그대로 출제하세요. 생성 결과가 형식만 맞으면 난이도나 표현 때문에 전체 퀴즈를 포기하지 마세요.\n\n반드시 지킬 규칙:\n1. ${compositionRule}\n2. 문맥 파악 문제를 가장 우선합니다. 좋은 예: “왜 이렇게 했나요?”, “이 일이 있은 뒤 어떤 일이 이어졌나요?”, “이때 인물의 마음은 왜 달라졌나요?”, “문제를 해결하기 위해 무엇을 했나요?”, “앞의 사건 때문에 뒤에 어떤 일이 생겼나요?” 같은 형태입니다.\n3. 문맥 문제는 자료에서 답을 찾을 수 있게 만드세요. 공개 자료가 짧을 때는 지나치게 세세한 장면 대신 줄거리와 중심 상황을 활용하세요.\n4. 수상 경력, 상 이름, 출판사, 출간 연도, 작가 경력, 그림 재료나 제작 기법, 판매 기록은 가급적 문제로 만들지 않습니다.\n5. 제목·저자·표지 모양을 묻지 않습니다.\n6. 질문은 되도록 짧고 쉽게 쓰되, 문맥을 정확히 묻기 위해 조금 길거나 어려워지는 것은 허용합니다.\n7. 객관식 보기는 정확히 4개이고 정답은 0부터 3 사이 인덱스입니다. 보기들도 같은 이야기 맥락 안에서 그럴듯하게 만듭니다.\n8. 각 객관식 evidence에는 정답을 뒷받침하는 이야기 근거를 씁니다.\n9. skill은 “문맥 이해”, “원인과 결과”, “사건 순서”, “인물 마음”, “내용 이해” 중 하나를 사용합니다.\n10. 자료가 충분하지 않더라도 제공된 줄거리와 중심 상황 안에서 무리하지 않는 문제를 끝까지 완성하세요.\n\n${reference}\n\nJSON 형식: {"title":"책 제목","author":"저자","questions":[{"type":"multiple_choice 또는 open_ended","question":"질문","options":["보기1","보기2","보기3","보기4"],"answer":0,"hint":"짧은 힌트","skill":"문맥 이해 또는 원인과 결과 또는 사건 순서 또는 인물 마음 또는 내용 이해 또는 생각 표현","explanation":"왜 그 답인지 이야기 흐름을 연결해 쉬운 말로 설명","evidence":"근거"}]}`;

    let quiz;
    let provider = 'kimi';
    if (kimiKey) {
      try {
        const text = await callKimi({ apiKey: kimiKey, model: kimiModel, prompt, maxTokens: questionCount === 10 ? 6000 : 3600 });
        quiz = validateQuiz(extractJson(text), questionCount);
      } catch (error) { console.warn('Kimi generation failed; falling back to Gemini', error.message); }
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
    if (/AI_EMPTY_RESPONSE|AI_JSON_NOT_FOUND|JSON/.test(message)) return send(res, 502, { message: 'AI가 올바른 형식으로 응답하지 않았습니다. 자동 재시도 후에도 실패했습니다.' });
    return send(res, 500, { message: '문제 형식을 만들지 못했습니다. 다시 한 번 눌러 주세요.' });
  }
}
