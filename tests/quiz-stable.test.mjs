import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/quiz-stable.js';

const depleted = { status: 402, message: 'Your prepayment credits are depleted. Please manage billing.' };
const rateLimit = { status: 429, message: 'organization max RPM: 3' };
const photo = 'data:image/jpeg;base64,aGVsbG8=';
const quiz = (count) => ({ title: '테스트 동화', author: '테스트 작가', questions: Array.from({ length: count }, (_, i) => ({
  question: `친구가 도움을 준 까닭은 무엇인가요? ${i + 1}`, options: ['도우려고', '놀리려고', '숨으려고', '도망가려고'], answer: 0,
  evidence: '친구가 어려움에 처해 있어서 도와주었어요.',
})) });
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

async function run(t, { count = 5, kimiFailure, searchFailure, proFailure, geminiFailure, malformedGemini = false,
  emptyReference = false, insufficientEvidence = false, hasKimi = true, hasGemini = true,
  supportPhotos = false, coverOnly = false, action = 'generate' } = {}) {
  const calls = { kimi: [], search: [], gemini: [], order: [] };
  const keys = ['GEMINI_API_KEY', 'KIMI_API_KEY', 'KIMI_MODEL'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  if (hasGemini) process.env.GEMINI_API_KEY = 'test-gemini-key'; else delete process.env.GEMINI_API_KEY;
  if (hasKimi) process.env.KIMI_API_KEY = 'test-kimi-key'; else delete process.env.KIMI_API_KEY;
  delete process.env.KIMI_MODEL;
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://www.googleapis.com/books/')) return response({ items: [] });
    const body = JSON.parse(options.body);
    if (url === 'https://api.moonshot.ai/v1/tools/search_pro' || url === 'https://api.moonshot.ai/v1/tools/search') {
      calls.search.push(body); calls.order.push('kimi-search');
      if (proFailure && url.endsWith('/search_pro')) return response({}, 502);
      if (searchFailure) return response({ error: { message: searchFailure.message } }, searchFailure.status);
      return response({ search_results: emptyReference ? [] : [{
        title: '테스트 동화 — 책 소개', url: 'https://example.com/book',
        snippet: '테스트 동화는 테스트 작가가 쓴 책입니다. 친구가 어려움에 처해 있어서 도와주었어요. 도움을 받은 친구도 나중에 다른 친구를 도와주며 함께 어려움을 해결했어요.',
        chunks: [{ text: '친구들은 어려운 일이 생기면 서로 도우며 함께 해결했어요.' }],
      }] });
    }
    if (url === 'https://api.moonshot.ai/v1/chat/completions') {
      calls.kimi.push(body); calls.order.push('kimi-chat');
      if (body.temperature !== undefined) return response({ error: { message: 'invalid temperature' } }, 400);
      if (kimiFailure) return response({ error: { message: kimiFailure.message } }, kimiFailure.status);
      const data = action === 'identify' ? { title: '테스트 동화', author: '테스트 작가', publisher: '테스트 출판사', confidence: 1 }
        : insufficientEvidence ? { insufficientEvidence: true, questions: [] } : quiz(count);
      return response({ choices: [{ message: { content: JSON.stringify(data) } }] });
    }
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    calls.gemini.push(body); calls.order.push('gemini');
    if (geminiFailure) return response({ error: { message: geminiFailure.message } }, geminiFailure.status);
    const data = body.tools ? (emptyReference ? {} : { summary: '테스트 동화: 친구가 어려워서 도와준 이야기', facts: [] })
      : action === 'identify' ? { title: '테스트 동화', author: '테스트 작가', publisher: '', confidence: 1 } : quiz(count);
    return response({ candidates: [{ content: { parts: [{ text: malformedGemini && !body.tools ? 'invalid JSON' : JSON.stringify(data) }] } }] });
  });
  const images = action === 'identify' || supportPhotos || coverOnly ? [photo] : [];
  const imageRoles = coverOnly ? ['front_cover'] : images.map(() => 'support');
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await handler({ method: 'POST', body: { action, title: '테스트 동화', author: '테스트 작가', grade: '초등 1학년', count, images, imageRoles } }, res);
  return { ...res, calls };
}

for (const count of [3, 5, 10]) {
  test(`Kimi searches and generates ${count} questions with zero Gemini calls`, async (t) => {
    const result = await run(t, { count, geminiFailure: depleted });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.provider, 'kimi');
    assert.equal(result.body.referenceProvider, 'kimi');
    assert.equal(result.body.model, 'kimi-k2.6');
    assert.equal(result.body.questions.length, count);
    assert.equal(result.body.sources[0].url, 'https://example.com/book');
    assert.deepEqual(result.calls.order, ['kimi-search', 'kimi-chat']);
    assert.match(result.calls.kimi[0].messages[1].content, /https:\/\/example.com\/book/);
    if (count === 10) {
      assert.equal(result.body.questions[9].type, 'open_ended');
      assert.deepEqual(result.body.questions[9].options, []);
      assert.equal(result.body.questions[9].answer, -1);
    } else assert.ok(result.body.questions.every((q) => q.type === 'multiple_choice'));
  });
}

test('Kimi works when GEMINI_API_KEY is absent', async (t) => {
  const result = await run(t, { hasGemini: false });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.calls.order, ['kimi-search', 'kimi-chat']);
});

test('cover recognition sends the image to Kimi first without Gemini', async (t) => {
  const result = await run(t, { action: 'identify', hasGemini: false });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.title, '테스트 동화');
  assert.equal(result.body.provider, 'kimi');
  assert.deepEqual(result.calls.order, ['kimi-chat']);
  assert.equal(result.calls.kimi[0].messages[1].content[1].image_url.url, photo);
});

test('support photos are read during generation in one Kimi call', async (t) => {
  const result = await run(t, { supportPhotos: true, hasGemini: false });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.calls.order, ['kimi-chat']);
  assert.equal(result.calls.kimi[0].messages[1].content[1].image_url.url, photo);
  assert.equal(result.body.referenceProvider, 'photos');
});

test('an already identified cover is not redundantly read or used as story evidence', async (t) => {
  const result = await run(t, { coverOnly: true, hasGemini: false });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.calls.order, ['kimi-search', 'kimi-chat']);
  assert.equal(typeof result.calls.kimi[0].messages[1].content, 'string');
});

test('Gemini generates only after a Kimi generation failure', async (t) => {
  const result = await run(t, { kimiFailure: rateLimit });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.provider, 'gemini_fallback');
  assert.deepEqual(result.calls.order, ['kimi-search', 'kimi-chat', 'gemini']);
});

test('Gemini search is only a backup when Kimi search fails', async (t) => {
  const result = await run(t, { searchFailure: { status: 500, message: 'search unavailable' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.provider, 'kimi');
  assert.equal(result.body.referenceProvider, 'gemini_fallback');
  assert.deepEqual(result.calls.order, ['kimi-search', 'kimi-search', 'gemini', 'kimi-chat']);
});

for (const [failure, status, code] of [
  [rateLimit, 429, 'AI_RATE_LIMITED'],
  [depleted, 402, 'AI_BILLING_REQUIRED'],
  [{ status: 401, message: 'API key not valid' }, 503, 'AI_AUTH_ERROR'],
  [{ status: 404, message: 'Not found the model' }, 503, 'AI_MODEL_UNAVAILABLE'],
  [{ status: 400, message: 'invalid request argument' }, 502, 'AI_REQUEST_ERROR'],
]) {
  test(`primary ${code} is not masked by Gemini's empty balance`, async (t) => {
    const result = await run(t, { kimiFailure: failure, geminiFailure: depleted });
    assert.equal(result.statusCode, status);
    assert.equal(result.body.code, code);
    assert.match(result.body.message, /Kimi/);
    assert.equal(result.calls.gemini.length, 1);
  });
}

test('unreadable photos do not become fabricated quizzes', async (t) => {
  const result = await run(t, { supportPhotos: true, hasGemini: false, insufficientEvidence: true });
  assert.equal(result.statusCode, 422);
  assert.equal(result.body.code, 'BOOK_REFERENCE_UNAVAILABLE');
});

test('empty search results never become an invented story', async (t) => {
  const result = await run(t, { emptyReference: true, hasGemini: false });
  assert.equal(result.statusCode, 422);
  assert.equal(result.body.code, 'BOOK_REFERENCE_UNAVAILABLE');
  assert.equal(result.calls.kimi.length, 0);
});

test('a cover alone cannot replace missing story sources', async (t) => {
  const result = await run(t, { emptyReference: true, coverOnly: true, hasGemini: false });
  assert.equal(result.statusCode, 422);
  assert.equal(result.calls.kimi.length, 0);
});

test('malformed backup JSON is retried with a distinct format error', async (t) => {
  const result = await run(t, { hasKimi: false, malformedGemini: true });
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.code, 'AI_INVALID_RESPONSE');
  assert.equal(result.calls.gemini.filter((body) => !body.tools).length, 3);
});


test('Kimi Basic search recovers a Pro outage before Gemini is tried', async (t) => {
  const result = await run(t, { proFailure: true, geminiFailure: depleted });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.provider, 'kimi');
  assert.deepEqual(result.calls.order, ['kimi-search', 'kimi-search', 'kimi-chat']);
  assert.equal(result.calls.search[1].include_content, true);
});
