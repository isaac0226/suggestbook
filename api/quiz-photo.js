import quizHandler from './quiz.js';

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

  return quizHandler(req, res);
}
