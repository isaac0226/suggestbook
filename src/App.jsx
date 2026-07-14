import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, CheckCircle2, Circle, Copy, ExternalLink, RefreshCw, Search, Send, Sparkles } from 'lucide-react';
import { catalog, profiles } from './catalog';

const STORAGE_KEY = 'suggestbook-state-v1';
const GANGNAM_SEARCH_URL = 'https://library.gangnam.go.kr/sklib/menu/11285/program/30001/plusSearchSimple.do';

const LIBRARIES = [
  '세곡도서관', '도곡정보문화도서관', '개포하늘꿈도서관', '논현도서관', '논현문화마루도서관',
  '논현문화마루도서관(별관)', '대치1작은도서관', '대치도서관', '못골도서관', '못골한옥어린이도서관',
  '삼성도서관', '세곡마루도서관', '역삼2작은도서관', '역삼도서관', '역삼푸른솔도서관',
  '열린도서관', '일원라온영어도서관', '정다운도서관', '즐거운도서관', '청담도서관',
  '행복한도서관', '개포4동주민도서관', '도곡2동주민도서관', '신사동주민도서관', '압구정동주민도서관',
  '일원본동주민도서관', '개포1동주민도서관'
];

function getWeekKey(date = new Date()) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
  return `${copy.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function seededScore(text, seed) {
  let h = 2166136261;
  const input = `${text}:${seed}`;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function getRecommendationCount(profile) {
  return profile.id === 'ire' || profile.id === 'iseol' ? 10 : profile.count;
}

function loadState() {
  const fallback = { read: {}, weekSalt: 0, library: '세곡도서관' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    const previousLibrary = saved.library || (saved.libraryId === 'segok' ? '세곡도서관' : undefined);
    return { ...fallback, ...saved, library: previousLibrary || fallback.library };
  } catch {
    return fallback;
  }
}

export default function App() {
  const [state, setState] = useState(loadState);
  const [activeProfile, setActiveProfile] = useState(profiles[0].id);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const weekKey = getWeekKey();

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const selectedLibrary = state.library || '세곡도서관';

  const recommendations = useMemo(() => {
    const result = {};
    profiles.forEach((profile) => {
      const readIds = new Set(state.read[profile.id] || []);
      const candidates = catalog
        .filter((book) => book.audience.includes(profile.id) && !readIds.has(book.id))
        .sort((a, b) => seededScore(a.id, `${weekKey}-${state.weekSalt}-${profile.id}`) - seededScore(b.id, `${weekKey}-${state.weekSalt}-${profile.id}`));
      result[profile.id] = candidates.slice(0, getRecommendationCount(profile));
    });
    return result;
  }, [state, weekKey]);

  const profile = profiles.find((item) => item.id === activeProfile);
  const profileRecommendationCount = getRecommendationCount(profile);
  const shownBooks = (recommendations[activeProfile] || []).filter((book) => {
    const target = `${book.title} ${book.author} ${book.tags.join(' ')}`.toLowerCase();
    return target.includes(query.trim().toLowerCase());
  });

  const showNotice = (message, duration = 2200) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), duration);
  };

  const toggleRead = (profileId, bookId) => {
    setState((prev) => {
      const current = new Set(prev.read[profileId] || []);
      current.add(bookId);
      return { ...prev, read: { ...prev.read, [profileId]: [...current] } };
    });
    showNotice('읽은 책으로 저장했어요. 다음 추천부터 제외됩니다.');
  };

  const restoreBook = (profileId, bookId) => {
    setState((prev) => ({
      ...prev,
      read: { ...prev.read, [profileId]: (prev.read[profileId] || []).filter((id) => id !== bookId) },
    }));
  };

  const reshuffle = () => {
    setState((prev) => ({ ...prev, weekSalt: (prev.weekSalt || 0) + 1 }));
    showNotice('아직 읽지 않은 책 안에서 추천 순서를 바꿨어요.');
  };

  const copyBookTitle = async (book) => {
    try {
      await navigator.clipboard.writeText(book.title);
      showNotice(`“${book.title}” 제목을 복사했어요.`);
    } catch {
      showNotice('제목 복사에 실패했어요. 제목을 길게 눌러 복사해 주세요.');
    }
  };

  const openLibrarySearch = async (book) => {
    try {
      await navigator.clipboard.writeText(book.title);
      showNotice(`“${book.title}” 제목을 복사했어요. 검색결과에서 ${selectedLibrary}만 체크해 주세요.`, 4000);
    } catch {
      showNotice(`${selectedLibrary}에서 “${book.title}”을 검색해 주세요.`, 3500);
    }
    window.open(GANGNAM_SEARCH_URL, '_blank', 'noopener,noreferrer');
  };

  const testTelegram = async () => {
    try {
      const response = await fetch('/api/telegram', { method: 'POST' });
      const data = await response.json();
      showNotice(data.ok ? '텔레그램 테스트 알림을 보냈어요.' : (data.message || '환경변수 설정 후 사용할 수 있어요.'), 3000);
    } catch {
      showNotice('텔레그램 설정을 확인해 주세요.', 3000);
    }
  };

  const readBooks = (state.read[activeProfile] || [])
    .map((id) => catalog.find((book) => book.id === id))
    .filter(Boolean);

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><Sparkles size={15} /> 이번 주 가족 독서 큐레이션</div>
          <h1>이번 주엔<br /><span>어떤 책을 만날까요?</span></h1>
          <p>인기도는 참고만 하고, 연령·관심사·작품성을 함께 고려해 골랐어요. 읽은 책은 체크하면 다음 추천에서 자동으로 빠집니다.</p>
          <div className="hero-actions">
            <button className="primary" onClick={reshuffle}><RefreshCw size={17} /> 추천 다시 섞기</button>
            <button className="secondary" onClick={testTelegram}><Send size={17} /> 텔레그램 테스트</button>
          </div>
        </div>
        <div className="hero-card">
          <BookOpen size={44} />
          <strong>{weekKey.replace('-', '년 ')}주차</strong>
          <span>이레 10권 · 이설 10권 · 부모 5권씩</span>
        </div>
      </header>

      <main>
        <section className="library-note">
          <div className="library-summary">
            <strong>주 이용 도서관: {selectedLibrary}</strong>
            <span>강남구 도서관 목록에서 선택하면 모든 추천 카드의 확인 버튼도 함께 바뀝니다.</span>
          </div>
          <div className="library-controls">
            <label>
              <span>도서관 선택</span>
              <select value={selectedLibrary} onChange={(event) => setState((prev) => ({ ...prev, library: event.target.value }))}>
                {LIBRARIES.map((library) => <option key={library} value={library}>{library}</option>)}
              </select>
            </label>
            <a href={GANGNAM_SEARCH_URL} target="_blank" rel="noreferrer">
              {selectedLibrary} 자료검색 <ExternalLink size={15} />
            </a>
          </div>
        </section>

        <section className="profile-tabs" aria-label="가족 선택">
          {profiles.map((item) => {
            const unreadCount = recommendations[item.id]?.length || 0;
            return (
              <button key={item.id} className={activeProfile === item.id ? 'profile active' : 'profile'} onClick={() => { setActiveProfile(item.id); setQuery(''); }}>
                <span className="profile-emoji">{item.emoji}</span>
                <span><strong>{item.name}</strong><small>{item.subtitle}</small></span>
                <em>{unreadCount}</em>
              </button>
            );
          })}
        </section>

        <section className="toolbar">
          <div>
            <p className="section-kicker">{profile.emoji} {profile.name}</p>
            <h2>이번 주 추천 {profileRecommendationCount}권</h2>
          </div>
          <label className="search-box">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목·저자·주제로 찾기" />
          </label>
        </section>

        {notice && <div className="notice">{notice}</div>}

        <section className="book-grid">
          {shownBooks.map((book, index) => (
            <article className="book-card" key={book.id}>
              <div className="rank">{String(index + 1).padStart(2, '0')}</div>
              <div className="book-body">
                <div className="tags">{book.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
                <div className="title-row">
                  <h3>{book.title}</h3>
                  <button className="copy-title-button" onClick={() => copyBookTitle(book)} title="책 제목 복사" aria-label={`${book.title} 제목 복사`}><Copy size={17} /></button>
                </div>
                <p className="author">{book.author}</p>
                <p className="reason">{book.reason}</p>
              </div>
              <div className="book-actions">
                <button className="library-button" onClick={() => openLibrarySearch(book)}><ExternalLink size={18} /> {selectedLibrary} 확인</button>
                <button className="read-button" onClick={() => toggleRead(activeProfile, book.id)} title="읽은 책으로 표시"><Circle size={20} /> 읽었어요</button>
              </div>
            </article>
          ))}
        </section>

        {shownBooks.length === 0 && (
          <div className="empty-state">
            <CheckCircle2 size={42} />
            <h3>추천할 새 책이 없어요</h3>
            <p>검색어를 지우거나, 아래 읽은 책 목록에서 잘못 체크한 책을 복원해 주세요.</p>
          </div>
        )}

        <section className="read-section">
          <div>
            <p className="section-kicker">독서 기록</p>
            <h2>{profile.name}이(가) 읽은 책 {readBooks.length}권</h2>
          </div>
          <div className="read-list">
            {readBooks.length === 0 ? <p className="muted">아직 체크한 책이 없습니다.</p> : readBooks.map((book) => (
              <button key={book.id} onClick={() => restoreBook(activeProfile, book.id)}><CheckCircle2 size={16} /> {book.title}<small>복원</small></button>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <strong>SuggestBook</strong>
        <span>선택한 도서관은 이 브라우저에 저장됩니다. 현재는 강남구 통합검색 결과에서 선택 도서관만 확인하는 방식입니다.</span>
      </footer>
    </div>
  );
}
