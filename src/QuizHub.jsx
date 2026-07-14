import React, { useMemo, useState } from 'react';
import { ArrowLeft, BookOpenCheck, Camera, CheckCircle2, ChevronLeft, ChevronRight, Clock3, History, Lightbulb, LoaderCircle, RefreshCw, RotateCcw, Sparkles, Trash2, X, XCircle } from 'lucide-react';
import App from './App';

const GRADES = ['유치원', '초등 1학년', '초등 2학년', '초등 3학년', '초등 4학년', '초등 5학년', '초등 6학년'];
const COUNTS = [3, 5, 10];
const HISTORY_KEY = 'suggestbook-quiz-history-v1';
const MAX_SUPPORT_PHOTOS = 2;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function getMessage(score, total) {
  const ratio = score / total;
  if (ratio === 1) return '완벽해요! 책의 내용을 아주 정확하게 기억하고 있어요.';
  if (ratio >= 0.8) return '아주 잘했어요! 중요한 장면과 인물을 잘 이해했어요.';
  if (ratio >= 0.6) return '실력이 점점 늘고 있어요. 틀린 부분만 다시 살펴보세요.';
  return '괜찮아요. 책의 주요 장면을 다시 떠올리면 다음에는 더 잘할 수 있어요.';
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('사진을 읽지 못했습니다.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('사진 형식을 확인해 주세요.'));
      image.onload = () => {
        const maxSide = 1400;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function QuizPage({ onBack }) {
  const [form, setForm] = useState({ grade: '초등 1학년', title: '', author: '', count: 3 });
  const [coverPhoto, setCoverPhoto] = useState(null);
  const [supportPhotos, setSupportPhotos] = useState([]);
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [hints, setHints] = useState({});
  const [screen, setScreen] = useState('form');
  const [history, setHistory] = useState(loadHistory);
  const [loading, setLoading] = useState(false);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [error, setError] = useState('');

  const score = useMemo(() => {
    if (!quiz) return 0;
    return quiz.questions.reduce((sum, question, index) => sum + (answers[index] === question.answer ? 1 : 0), 0);
  }, [quiz, answers]);

  const handleCoverPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPhotoLoading(true);
    setError('');
    try {
      setCoverPhoto({ name: file.name, dataUrl: await compressImage(file) });
    } catch (err) {
      setError(err.message || '앞표지 사진을 불러오지 못했습니다.');
    } finally {
      setPhotoLoading(false);
    }
  };

  const handleSupportPhotos = async (event) => {
    const files = [...event.target.files].slice(0, MAX_SUPPORT_PHOTOS - supportPhotos.length);
    event.target.value = '';
    if (!files.length) return;
    setPhotoLoading(true);
    setError('');
    try {
      const next = await Promise.all(files.map(async (file) => ({ name: file.name, dataUrl: await compressImage(file) })));
      setSupportPhotos((current) => [...current, ...next].slice(0, MAX_SUPPORT_PHOTOS));
    } catch (err) {
      setError(err.message || '추가 사진을 불러오지 못했습니다.');
    } finally {
      setPhotoLoading(false);
    }
  };

  const saveResult = () => {
    const record = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, completedAt: new Date().toISOString(), quiz, answers, score, total: quiz.questions.length };
    const next = [record, ...history].slice(0, 50);
    setHistory(next);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  };

  const generateQuiz = async () => {
    if (!coverPhoto) {
      setError('책 앞표지를 먼저 촬영해 주세요.');
      return;
    }
    setLoading(true);
    setError('');
    setSubmitted(false);
    setAnswers({});
    setHints({});
    setCurrentIndex(0);
    try {
      const images = [coverPhoto.dataUrl, ...supportPhotos.map((photo) => photo.dataUrl)];
      const imageRoles = ['front_cover', ...supportPhotos.map(() => 'support')];
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, images, imageRoles }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '퀴즈 생성에 실패했어요.');
      setQuiz(data);
      setScreen('quiz');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message || '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setQuiz(null); setAnswers({}); setHints({}); setSubmitted(false); setCurrentIndex(0); setError(''); setCoverPhoto(null); setSupportPhotos([]); setScreen('form');
  };

  const restart = () => { setAnswers({}); setHints({}); setSubmitted(false); setCurrentIndex(0); setScreen('quiz'); };
  const submitQuiz = () => { setSubmitted(true); saveResult(); setScreen('result'); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const openRecord = (record) => {
    setQuiz(record.quiz);
    setForm({ grade: record.quiz.grade, title: record.quiz.title, author: record.quiz.author, count: record.total });
    setCoverPhoto(null); setSupportPhotos([]); setAnswers(record.answers); setSubmitted(true); setHints({}); setCurrentIndex(0); setScreen('quiz');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const removeRecord = (id) => {
    const next = history.filter((item) => item.id !== id);
    setHistory(next); localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  };

  if (screen === 'result' && quiz) {
    const correctItems = quiz.questions.filter((question, index) => answers[index] === question.answer);
    const wrongItems = quiz.questions.filter((question, index) => answers[index] !== question.answer);
    const strengths = [...new Set(correctItems.map((item) => item.skill || '내용 이해'))];
    return <div className="quiz-page">
      <header className="quiz-header compact result-heading"><button className="quiz-back" onClick={reset}><ArrowLeft size={18} /> 새 책 입력</button><p className="section-kicker"><BookOpenCheck size={16} /> {quiz.title}</p><h1>퀴즈 결과</h1><p>{quiz.author} · {quiz.grade} · {quiz.questions.length}문제</p></header>
      <main className="quiz-main result-page">
        <section className="result-score-card"><span>점수</span><div className="score-ring"><strong>{score}/{quiz.questions.length}</strong><small>정답</small></div><p>{getMessage(score, quiz.questions.length)}</p></section>
        <section className="result-analysis"><h2>강점</h2>{strengths.length ? strengths.slice(0, 4).map((skill, index) => <div className="analysis-item" key={skill}><b>{index + 1}.</b><p><strong>{skill}</strong> 관련 문제를 잘 풀었어요. 책의 중요한 장면과 내용을 정확히 기억하고 있습니다.</p></div>) : <p className="muted">이번에는 강점보다 복습할 부분을 먼저 찾아보면 좋아요.</p>}<h2>중점적으로 살펴볼 영역</h2>{wrongItems.length ? wrongItems.map((item, index) => <div className="analysis-item" key={`${item.question}-${index}`}><b>{index + 1}.</b><p><strong>{item.skill || '내용 이해'}:</strong> “{item.question}”과 관련된 장면을 책에서 다시 확인해 보세요.</p></div>) : <div className="analysis-item"><b>1.</b><p><strong>생각 넓히기:</strong> 모든 문제를 맞혔어요. 등장인물의 마음이나 이야기의 핵심 메시지를 가족과 이야기해 보세요.</p></div>}</section>
        <div className="result-actions"><button className="primary" onClick={() => { setCurrentIndex(0); setScreen('quiz'); }}><BookOpenCheck size={17} /> 문제와 정답 다시보기</button><button className="secondary" onClick={restart}><RotateCcw size={17} /> 다시 풀기</button></div>
        <section className="regenerate-panel"><p>문제에 오류가 있을 수 있습니다. 문제가 이상하다면 다시 출제 버튼을 눌러 새롭게 문제를 생성하세요.</p><button className="secondary" onClick={generateQuiz} disabled={loading}><RefreshCw size={17} /> 문제 다시 출제하기</button></section>
      </main>
    </div>;
  }

  if (screen === 'history') return <div className="quiz-page">
    <header className="quiz-header compact"><button className="quiz-back" onClick={() => setScreen('form')}><ArrowLeft size={18} /> 독서퀴즈로</button><p className="section-kicker"><History size={16} /> 퀴즈 기록</p><h1>읽었던 책과<br />퀴즈 결과</h1><p>문제, 내가 고른 답, 정답과 해설을 다시 볼 수 있습니다.</p></header>
    <main className="quiz-main">{history.length === 0 ? <section className="history-empty"><History size={30} /><h2>아직 저장된 기록이 없어요</h2><p>퀴즈를 끝까지 풀면 이곳에 자동으로 저장됩니다.</p></section> : <section className="history-list">{history.map((record) => <article className="history-card" key={record.id}><div><span>{record.quiz.grade}</span><h2>{record.quiz.title}</h2><p>{record.quiz.author}</p><small><Clock3 size={13} /> {formatDate(record.completedAt)}</small></div><strong>{record.score}/{record.total}</strong><div className="history-actions"><button onClick={() => openRecord(record)}>다시 보기</button><button aria-label="기록 삭제" onClick={() => removeRecord(record.id)}><Trash2 size={17} /></button></div></article>)}</section>}</main>
  </div>;

  if (screen === 'quiz' && quiz) {
    const question = quiz.questions[currentIndex];
    const isCorrect = submitted && answers[currentIndex] === question.answer;
    const isLast = currentIndex === quiz.questions.length - 1;
    return <div className="quiz-page">
      <header className="quiz-header compact"><button className="quiz-back" onClick={reset}><ArrowLeft size={18} /> 새 책 입력</button><p className="section-kicker"><BookOpenCheck size={16} /> 독서퀴즈</p><h1>{quiz.title}</h1><p>{quiz.author} · {quiz.grade} · {quiz.questions.length}문제</p></header>
      <main className="quiz-main"><div className="quiz-progress"><span>{currentIndex + 1} / {quiz.questions.length}</span><div><i style={{ width: `${((currentIndex + 1) / quiz.questions.length) * 100}%` }} /></div></div>
        <article className={`question-card single ${submitted ? (isCorrect ? 'correct' : 'wrong') : ''}`}><div className="question-number">문제 {String(currentIndex + 1).padStart(2, '0')}</div><h2>{question.question}</h2>{!submitted && <><button className="hint-button" onClick={() => setHints((prev) => ({ ...prev, [currentIndex]: !prev[currentIndex] }))}><Lightbulb size={17} /> {hints[currentIndex] ? '힌트 숨기기' : '힌트 보기'}</button>{hints[currentIndex] && <div className="hint-box"><Lightbulb size={18} /><span>{question.hint}</span></div>}</>}<div className="options-list">{question.options.map((option, optionIndex) => <button key={`${option}-${optionIndex}`} className={`${answers[currentIndex] === optionIndex ? 'selected' : ''} ${submitted && optionIndex === question.answer ? 'correct-option' : ''}`} onClick={() => !submitted && setAnswers((prev) => ({ ...prev, [currentIndex]: optionIndex }))} disabled={submitted}><span>{optionIndex + 1}</span>{option}</button>)}</div>{submitted && <div className="answer-feedback">{isCorrect ? <CheckCircle2 size={19} /> : <XCircle size={19} />}<div><strong>{isCorrect ? '정답이에요' : `정답은 ${question.answer + 1}번이에요`}</strong><p>{question.explanation}</p></div></div>}</article>
        <div className="question-navigation"><button className="secondary" disabled={currentIndex === 0} onClick={() => setCurrentIndex((value) => value - 1)}><ChevronLeft size={17} /> 이전</button>{!submitted && isLast ? <button className="primary" disabled={Object.keys(answers).length !== quiz.questions.length} onClick={submitQuiz}>채점하기</button> : <button className="primary" disabled={isLast || (!submitted && answers[currentIndex] === undefined)} onClick={() => setCurrentIndex((value) => value + 1)}>다음 <ChevronRight size={17} /></button>}</div>
        {submitted && <button className="result-return-button" onClick={() => setScreen('result')}>결과 화면으로 돌아가기</button>}
        <section className="regenerate-panel compact-panel"><p>문제에 오류가 있을 수 있습니다. 문제가 이상하다면 다시 출제 버튼을 눌러 새롭게 문제를 생성하세요.</p><button className="secondary" onClick={generateQuiz} disabled={loading}><RefreshCw size={17} /> 문제 다시 출제하기</button></section>{error && <p className="quiz-error">{error}</p>}
      </main>
    </div>;
  }

  return <div className="quiz-page">
    <header className="quiz-header"><button className="quiz-back" onClick={onBack}><ArrowLeft size={18} /> 추천도서로</button><div className="eyebrow"><Sparkles size={15} /> 책을 찍으면 바로 시작</div><h1>앞표지 한 장으로<br /><span>독서퀴즈 만들기</span></h1><p>앞표지를 찍으면 책 제목과 저자 정보를 읽어 퀴즈를 만듭니다. 뒷표지, 목차나 본문 사진을 더하면 문제 정확도가 높아집니다.</p></header>
    <main className="quiz-main"><div className="quiz-start-actions"><button className="history-open-button" onClick={() => setScreen('history')}><History size={17} /> 저장된 퀴즈 기록 <span>{history.length}</span></button></div>
      <section className="quiz-form-card"><label><span>학년</span><select value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })}>{GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label>
        <div className={`cover-photo-card ${coverPhoto ? 'has-photo' : ''}`}><div className="cover-photo-heading"><div><strong>앞표지 사진 <em>필수</em></strong><span>책 제목·권수·저자 확인용</span></div><label className="photo-add-button"><Camera size={18} /> {photoLoading ? '준비 중…' : coverPhoto ? '다시 촬영' : '앞표지 촬영'}<input type="file" accept="image/*" capture="environment" disabled={photoLoading} onChange={handleCoverPhoto} /></label></div>{coverPhoto ? <div className="cover-preview"><img src={coverPhoto.dataUrl} alt="책 앞표지" /><button type="button" aria-label="앞표지 사진 삭제" onClick={() => setCoverPhoto(null)}><X size={16} /></button><span>앞표지</span></div> : <div className="cover-photo-guide"><Camera size={28} /><p>책 전체가 화면 안에 들어오고 제목이 선명하게 보이도록 찍어 주세요.</p></div>}</div>
        <div className="photo-source support-photo-card"><div className="photo-source-heading"><div><strong>내용 참고 사진</strong><span>선택사항 · 최대 {MAX_SUPPORT_PHOTOS}장</span></div><label className={`photo-add-button ${supportPhotos.length >= MAX_SUPPORT_PHOTOS ? 'disabled' : ''}`}><Camera size={18} /> {photoLoading ? '준비 중…' : '추가 촬영'}<input type="file" accept="image/*" capture="environment" multiple disabled={photoLoading || supportPhotos.length >= MAX_SUPPORT_PHOTOS} onChange={handleSupportPhotos} /></label></div><p>뒷표지 책 소개, 목차 또는 중요한 본문을 찍어 주세요. 사진이 없으면 앞표지와 공개된 책 정보를 바탕으로 출제합니다.</p>{supportPhotos.length > 0 && <div className="photo-preview-list">{supportPhotos.map((photo, index) => <div className="photo-preview" key={`${photo.name}-${index}`}><img src={photo.dataUrl} alt={`내용 참고 사진 ${index + 1}`} /><button type="button" aria-label={`추가 사진 ${index + 1} 삭제`} onClick={() => setSupportPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={15} /></button><span>{index + 1}</span></div>)}</div>}<small>사진은 퀴즈 생성에만 사용하며 퀴즈 기록에는 저장하지 않습니다.</small></div>
        <details className="manual-book-info"><summary>책 정보를 직접 추가하기 <span>선택사항</span></summary><div><label><span>책 이름</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="사진이 흐릴 때만 입력" /></label><label><span>저자·옮긴이·출판사</span><input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} placeholder="알고 있는 정보가 있을 때만 입력" /></label></div></details>
        <fieldset><legend>문제 수</legend><div className="count-options">{COUNTS.map((count) => <button type="button" className={form.count === count ? 'active' : ''} key={count} onClick={() => setForm({ ...form, count })}>{count}문제</button>)}</div></fieldset><button className="primary generate-button" onClick={generateQuiz} disabled={loading || photoLoading || !coverPhoto}>{loading ? <><LoaderCircle className="spin" size={18} /> 문제 만드는 중…</> : <><BookOpenCheck size={18} /> 퀴즈 만들기</>}</button>{error && <p className="quiz-error">{error}</p>}<p className="quiz-caution">앞표지는 필수이며, 뒷표지·목차·본문 사진은 선택사항입니다.</p>
      </section>
    </main>
  </div>;
}

export default function QuizHub() {
  const [view, setView] = useState('books');
  return <><nav className="top-category-nav"><button className={view === 'books' ? 'active' : ''} onClick={() => setView('books')}><BookOpenCheck size={17} /> 추천도서</button><button className={view === 'quiz' ? 'active' : ''} onClick={() => setView('quiz')}><Sparkles size={17} /> 독서퀴즈</button></nav>{view === 'books' ? <App /> : <QuizPage onBack={() => setView('books')} />}</>;
}
