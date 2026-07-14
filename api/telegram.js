export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const appUrl = process.env.APP_URL || 'https://suggestbook.vercel.app';

  if (!token || !chatId) {
    return res.status(503).json({
      ok: false,
      message: 'TELEGRAM_BOT_TOKEN과 TELEGRAM_CHAT_ID 환경변수가 아직 설정되지 않았습니다.',
    });
  }

  const text = [
    '📚 이번 주 가족 추천도서가 준비됐어요.',
    '',
    '아이별 20권, 부모별 5권을 확인하고 읽은 책은 체크해 주세요.',
    appUrl,
  ].join('\n');

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      return res.status(502).json({ ok: false, message: data.description || '텔레그램 전송에 실패했습니다.' });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'Unknown error' });
  }
}
