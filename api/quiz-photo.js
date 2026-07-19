export default async function handler(req, res) {
  if (req.method === 'POST') {
    const body = req.body || {};
    const images = Array.isArray(body.images) ? body.images : [];

    if (!images.length) {
      return res.status(400).json({ message: '책 앞표지 사진을 먼저 촬영해 주세요.' });
    }

    req.body = {
      ...body,
      title: body.title?.trim() || '앞표지 사진에서 확인',
      author: body.author?.trim() || '앞표지 사진에서 확인',
      images,
    };
  }

  // Vercel 번들링 방식에 따라 default export가 한 번 더 감싸질 수 있어
  // 실행 시점에 실제 함수가 나올 때까지 안전하게 풀어냅니다.
  const module = await import('./quiz.js');
  const quizHandler =
    (typeof module.default === 'function' && module.default) ||
    (typeof module.default?.default === 'function' && module.default.default) ||
    (typeof module.handler === 'function' && module.handler);

  if (!quizHandler) {
    console.error('quiz handler export shape', Object.keys(module), typeof module.default, Object.keys(module.default || {}));
    return res.status(500).json({ message: '퀴즈 서버 연결을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  return quizHandler(req, res);
}
