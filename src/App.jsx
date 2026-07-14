import React, { useEffect, useMemo, useState } from 'react';
import { BookOpen, CheckCircle2, Circle, RefreshCw, Search, Send, Sparkles } from 'lucide-react';
import { catalog, profiles } from './catalog';

const STORAGE_KEY = 'suggestbook-state-v1';

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

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { read: {}, weekSalt: 0 };
  } catch {
    return { read: {}, weekSalt: 0 };
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

  const recommendations = useMemo(() => {
    const result = {};
    profiles.forEach((profile) => {
      const readIds = new Set(state.read[profile.id] || []);
      const candidates = catalog
        .filter((book) => book.audience.includes(profile.id) && !readIds.has(book.id))
        .sort((a, b) => seededScore(a.id, `${weekKey}-${state.weekSalt}-${profile.id}`) - seededScore(b.id, `${weekKey}-${state.weekSalt}-${profile.id}`));
      result[profile.id] = candidates.slice(0, profile.count);
    });
    return result;
  }, [state, weekKey]);

  const profile = profiles.find((item) => item.id === activeProfile);
  const shownBooks = (recommendations[activeProfile] || []).filter((book) => {
    const target = `${book.title} ${book.author} ${book.tags.join(' ')}`.toLowerCase();
    return target.includes(query.trim().toLowerCase());
  });

  const toggleRead = (profileId, bookId) => {
    setState((prev) => {
      const current = new Set(prev.read[profileId] || []);
      current.add(bookId);
      return { ...prev, read: { ...prev.read, [profileId]: [...current] } };
    });
    setNotice('읽은 책으로 저장했어요. 다음 추천부터 제외됩니다.');
    window.setTimeout(() => setNotice(''), 2200);
  };

  const restoreBook = (profileId, bookId) => {
    setState((prev) => ({
      ...prev,
      read: {
        ...prev.read,
        [profileId]: (prev.read[profileId] || []).filter((id) => id !== bookId),
      },
    }));
  };

  const reshuffle = () => {
    setState((prev) => ({ ...prev, weekSalt: (prev.weekSalt || 0) + 1 }));
    setNotice('아직 읽지 않은 책 안에서 추천 순서를 바꿨어요.');
    window.setTimeout(() => setNotice(''), 2200);
  };

  const testTelegram = async () => {
    try {
      const response = await fetch('/api/telegram', { method: 'POST' });
      const data = await response.json();
      setNotice(data.ok ? '텔레그램 테스트 알림을 보냈어요.' : (data.message || '환경변수 설정 후 사용할 수 있어요.'));
    } catch {
      setNotice('텔레그램 설정을 확인해 주세요.');
    }
    window.setTimeout(() => setNotice(''), 3000);
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
          <span>아이 20권씩 · 부모 5권씩</span>
        </div>
      </header>

      <main>
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
            <h2>이번 주 추천 {profile.count}권</h2>
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
                <h3>{book.title}</h3>
                <p className="author">{book.author}</p>
                <p className="reason">{book.reason}</p>
              </div>
              <button className="read-button" onClick={() => toggleRead(activeProfile, book.id)} title="읽은 책으로 표시">
                <Circle size={22} /> 읽었어요
              </button>
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
        <span>현재 독서 기록은 이 기기의 브라우저에 저장됩니다. 추후 인기대출 API와 공용 저장소를 연결할 수 있도록 구성했습니다.</span>
      </footer>
    </div>
  );
}
