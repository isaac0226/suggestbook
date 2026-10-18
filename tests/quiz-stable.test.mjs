import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/quiz-stable.js';

const depleted = { status: 429, message: 'Your prepayment credits are depleted. Please go to AI Studio to manage billing.' };
const quiz = (count) => ({ title: '테스트 동화', author: '테스트 작가', questions: Array.from({ length: count }, (_, i) => ({
  question: `친구가 도움을 준 까닭은 무엇인가요? ${i + 1}`, options: ['도우려고', '놀리려고', '숨으려고', '도망가려고'], answer: 0,
  evidence: '친구가 어려움에 처해 있어서 도와주었어요.',
})) });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

async function run(t, { count = 5, kimiFailure, geminiFailure, malformed = false, emptyReference = false, action = 'generate' } = {}) {
  const calls = { kimi: [], gemini: [] };
  const original = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, KIMI_API_KEY: process.env.KIMI_API_KEY };
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.KIMI_API_KEY = 'test-kimi-key';
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (emptyReference && url.startsWith('https://www.googleapis.com/books/')) return response({ items: [] });
    if (url.startsWith('https://www.googleapis.com/books/')) return response({ items: [{ volumeInfo: {
      title: '테스트 동화', authors: ['테스트 작가'], description: '친구가 어려움에 처해 있어서 도와주었어요.',
    } }] });
    const body = JSON.parse(options.body);
    if (url.startsWith('https://api.moonshot.ai/')) {
      calls.kimi.push(body);
      // Reproduce the actual provider contract instead of accepting any payload.
      if (body.temperature !== undefined && body.temperature !== 1) {
        return response({ error: { message: 'invalid temperature: only 1 is allowed for this model' } }, 400);
      }
      if (kimiFailure) return response({ error: { message: kimiFailure.message } }, kimiFailure.status);
      return response({ choices: [{ message: { content: JSON.stringify(quiz(count)) } }] });
    }
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    calls.gemini.push(body);
    if (geminiFailure) return response({ error: { message: geminiFailure.message } }, geminiFailure.status);
    const content = body.tools ? (emptyReference ? {} : { summary: '친구를 도와주는 이야기', facts: ['친구가 어려워서 도와줬다.'], confidence: 1 }) : quiz(count);
    return response({ candidates: [{ content: { parts: [{ text: malformed && !body.tools ? 'invalid JSON' : JSON.stringify(content) }] } }] });
  });
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await handler({ method: 'POST', body: { action, title: '테스트 동화', grade: '초등 1학년', count,
    images: action === 'identify' ? ['data:image/jpeg;base64,aGVsbG8='] : [],
  } }, res);
  return { ...res, calls };
}

for (const count of [3, 5, 10]) {
  test(`Kimi produces ${count} questions while Gemini credits are depleted`, async (t) => {
    const result = await run(t, { count, geminiFailure: depleted });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.provider, 'kimi');
    assert.equal(result.body.questions.length, count);
    assert.equal(result.calls.kimi.length, 1);
    assert.equal(result.calls.gemini.length, 1); // Optional research only; no generation fallback.
    if (count === 10) {
      assert.equal(result.body.questions[9].type, 'open_ended');
      assert.deepEqual(result.body.questions[9].options, []);
      assert.equal(result.body.questions[9].answer, -1);
    } else assert.ok(result.body.questions.every((q) => q.type === 'multiple_choice'));
  });
}

test('Gemini fallback still generates questions when Kimi is rate limited', async (t) => {
  const result = await run(t, { kimiFailure: { status: 429, message: 'organization max RPM: 3' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.provider, 'gemini_fallback');
  assert.equal(result.body.questions.length, 5);
});

for (const [failure, expectedStatus, expectedCode] of [
  [depleted, 402, 'AI_BILLING_REQUIRED'],
  [{ status: 401, message: 'API key not valid' }, 503, 'AI_AUTH_ERROR'],
  [{ status: 429, message: 'RESOURCE_EXHAUSTED quota' }, 429, 'AI_RATE_LIMITED'],
  [{ status: 400, message: 'invalid request argument' }, 502, 'AI_REQUEST_ERROR'],
  [{ status: 404, message: 'Not found the model or Permission denied' }, 503, 'AI_MODEL_UNAVAILABLE'],
]) {
  test(`${expectedCode} is reported accurately without repeated provider requests`, async (t) => {
    const result = await run(t, { kimiFailure: { status: 500, message: 'temporarily unavailable' }, geminiFailure: failure });
    assert.equal(result.statusCode, expectedStatus);
    assert.equal(result.body.code, expectedCode);
    assert.match(result.body.message, /Gemini/);
    assert.equal(result.calls.gemini.filter((body) => !body.tools).length, 1);
  });
}

test('cover recognition reports depleted credit instead of a photo parsing error', async (t) => {
  const result = await run(t, { action: 'identify', geminiFailure: depleted });
  assert.equal(result.statusCode, 402);
  assert.equal(result.body.code, 'AI_BILLING_REQUIRED');
  assert.equal(result.calls.gemini.length, 1);
});

test('malformed JSON is retried and remains distinct from provider failures', async (t) => {
  const result = await run(t, { kimiFailure: { status: 500, message: 'temporarily unavailable' }, malformed: true });
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.code, 'AI_INVALID_RESPONSE');
  assert.equal(result.calls.gemini.filter((body) => !body.tools).length, 3);
});

test('a failed research request cannot produce an invented quiz from just the title', async (t) => {
  const result = await run(t, { emptyReference: true, geminiFailure: depleted });
  assert.equal(result.statusCode, 402);
  assert.equal(result.body.code, 'AI_BILLING_REQUIRED');
  assert.equal(result.calls.kimi.length, 0);
});

test('an unknown book asks for source photos instead of inventing story evidence', async (t) => {
  const result = await run(t, { emptyReference: true });
  assert.equal(result.statusCode, 422);
  assert.equal(result.body.code, 'BOOK_REFERENCE_UNAVAILABLE');
  assert.equal(result.calls.kimi.length, 0);
});
