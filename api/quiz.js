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

function validateQuiz(data, expectedCount) {
  if (!data || !Array.isArray(data.questions) || data.questions.length !== expectedCount) {
    throw new Error('문제 수가 올바르지 않습니다.');
  }
  data.questions.forEach((item) => {
    if (!item.question || !Array.isArray(item.options) || item.options.length !== 4) throw new Error('문제 형식이 올바르지 않습니다.');
    if (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3) throw new Error('정답 형식이 올바르지 않습니다.');
    if (!item.explanation) item.explanation = '책의 해당 장면을 다시 떠올려 보세요.';
  });
  return data;
}

function normalizeModel(value) {
  let model = (value || 'gemini-3.1-flash-lite').trim();
  if (model.startsWith('emini-')) model = `g${model}`;
  if (model === 'gemini-2.5-flash-lite') model = 'gemini-3.1-flash-lite';
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

  const prompt = `당신은 한국 초등학생을 위한 독서퀴즈 출제자입니다.\n책: “${title.trim()}”\n책 식별 정보(저자, 옮긴이 또는 출판사): ${author.trim()}\n대상: ${grade}\n문제 수: ${questionCount}\n\n규칙:\n1. 입력된 책 제목과 식별 정보를 함께 사용해 정확한 판본을 찾으세요. 저자가 아니라 옮긴이 또는 출판사가 입력될 수도 있습니다.\n2. 책의 실제 내용에 근거한 객관식 문제만 만드세요. 책 내용을 확실히 알 수 없다면 지어내지 말고 JSON의 error에 그 사실을 적으세요.\n3. 등장인물, 사건, 배경, 핵심 메시지를 골고루 묻되 학년 수준에 맞는 쉬운 한국어를 사용하세요.\n4. 선택지는 정확히 4개이며 정답은 0부터 3까지의 배열 인덱스입니다.\n5. 모호하거나 의견에 따라 답이 달라지는 문제는 만들지 마세요.\n6. 기존 문제를 재출제하는 상황일 수 있으므로 서로 다른 장면과 표현을 사용하세요.\n7. 설명은 한두 문장으로 짧게 쓰세요.\n\n반드시 아래 JSON만 출력하세요.\n{\n  "title": "책 이름",\n  "author": "입력된 책 식별 정보",\n  "grade": "대상 학년",\n  "questions": [\n    {\n      "question": "문제",\n      "options": ["선택지1", "선택지2", "선택지3", "선택지4"],\n      "answer": 0,\n      "explanation": "정답 설명"\n    }\n  ]\n}`;

  try {
    const result = await callGemini({
      apiKey,
      model,
      prompt,
      maxOutputTokens: questionCount === 10 ? 4096 : 2500,
      temperature: 0.65,
    });
    const text = result?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    const parsed = extractJson(text);
    if (parsed.error) return send(res, 422, { message: parsed.error });
    const quiz = validateQuiz(parsed, questionCount);
    return send(res, 200, { ...quiz, title: title.trim(), author: author.trim(), grade });
  } catch (error) {
    console.error('quiz generation error', error);
    return send(res, 500, { message: error.message || '퀴즈 생성 중 오류가 발생했습니다.' });
  }
}
