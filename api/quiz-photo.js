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

  // Gemini 3.5 Flash가 이미지 식별 단계에서 생각 토큰만 사용하고
  // 본문 JSON을 비워 반환하는 경우가 있어, 사진 퀴즈 경로는
  // 이미지·구조화 출력이 안정적인 모델을 사용한다.
  process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
  const { default: quizHandler } = await import('./quiz.js');
  return quizHandler(req, res);
}
