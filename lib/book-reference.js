const ORIGIN = 'https://www.aladin.co.kr';

function plainText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] || all;
      const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    }).replace(/\s+/g, ' ').trim();
}

const normalize = (text) => plainText(text).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

async function page(url, referer) {
  // Only fixed public catalogue URLs are fetched; model output never supplies a URL.
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', ...(referer ? { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' } : {}) },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('BOOK_REFERENCE_UNAVAILABLE');
  return response.text();
}

export async function publicBookReference(book) {
  const author = book.author === '저자 정보 없음' ? '' : book.author;
  const query = [book.title, author, book.publisher].filter(Boolean).join(' ');
  const html = await page(`${ORIGIN}/search/wsearchresult.aspx?SearchTarget=Book&SearchWord=${encodeURIComponent(query)}`);
  let itemId;
  for (const match of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)) {
    if (!/class=["'][^"']*\bbo3\b/i.test(match[1]) || normalize(match[2]) !== normalize(book.title)) continue;
    const id = match[1].match(/href=["']https:\/\/www\.aladin\.co\.kr\/shop\/wproduct\.aspx\?ItemId=(\d+)["']/i)?.[1];
    const row = html.slice(match.index + match[0].length).split('</ul>')[0];
    const rowAuthor = [...row.matchAll(/<a\b[^>]*AuthorSearch[^>]*>([\s\S]*?)<\/a>/gi)].map((entry) => normalize(entry[1])).join(' ');
    const rowPublisher = [...row.matchAll(/<a\b[^>]*PublisherSearch[^>]*>([\s\S]*?)<\/a>/gi)].map((entry) => normalize(entry[1])).join(' ');
    if (id && (!author || rowAuthor.includes(normalize(author))) && (!book.publisher || rowPublisher.includes(normalize(book.publisher)))) { itemId = id; break; }
  }
  if (!itemId) throw new Error('BOOK_REFERENCE_UNAVAILABLE');
  const url = `${ORIGIN}/shop/wproduct.aspx?ItemId=${itemId}`;
  const product = await page(url);
  const isbn = product.match(/id=["']([0-9x]{10,13})_Introduce["']/i)?.[1];
  if (!isbn) throw new Error('BOOK_REFERENCE_UNAVAILABLE');
  const hour = (new Date().getUTCHours() + 9) % 24;
  const sections = await Promise.allSettled(['Introduce', 'PublisherDesc'].map((name) => page(`${ORIGIN}/shop/product/getContents.aspx?ISBN=${isbn}&name=${name}&type=0&date=${hour}`, url)));
  const passages = sections.filter((result) => result.status === 'fulfilled').map((result) => plainText(result.value).slice(0, 10000)).filter((text) => text.length >= 80);
  if (!passages.length) throw new Error('BOOK_REFERENCE_UNAVAILABLE');
  return {
    summary: `제목: ${book.title}\n저자: ${author}\n공개 도서 소개 출처: ${url}\n${passages.join('\n\n')}`,
    facts: [], sources: [{ title: `${book.title} — 알라딘 책 소개`, url }], sourceProvider: 'public_catalog',
  };
}
