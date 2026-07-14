import React, { useMemo, useState } from 'react';
import { ArrowLeft, BookOpenCheck, CheckCircle2, LoaderCircle, RefreshCw, RotateCcw, Sparkles, XCircle } from 'lucide-react';
import App from './App';

const GRADES = ['유치원', '초등 1학년', '초등 2학년', '초등 3학년', '초등 4학년', '초등 5학년', '초등 6학년'];
const COUNTS = [3, 5, 10];

function QuizPage({ onBack }) {
  const [form, setForm] = useState({ grade: '초등 1학년', title: '', author: '', count: 3 });
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const score = useMemo(() => {
    if (!quiz || !submitted) return 0;
    return quiz.questions.reduce((sum, question, index) => sum + (answers[index] === question.answer ? 1 : 0), 0);
  }, [quiz, answers, submitted]);

  const generateQuiz = async () => {
    if (!form.title.trim() || !form.author.trim()) {
      setError('책 이름과 저자를 모두 입력해 주세요.');
      return;
    }
    setLoading(true);
    setError('');
    setSubmitted(false);
    setAnswers({});
    try {
      const response = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '퀴즈 생성에 실패했어요.');
      setQuiz(data);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message || '잠시 후 다시 시도해 주세요.');
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setQuiz(null);
    setAnswers({});
    setSubmitted(false);
    setError('');
  };

  if (quiz) {
    return (
      <div className="quiz-page">
        <header className="quiz-header compact">
          <button className="quiz-back" onClick={reset}><ArrowLeft size={18} /> 새 책 입력</button>
          <p className="section-kicker"><BookOpenCheck size={16} /> 독서퀴즈</p>
          <h1>{quiz.title}</h1>
          <p>{quiz.author} · {quiz.grade} · {quiz.questions.length}문제</p>
        </header>

        <main className="quiz-main">
          {submitted && (
            <section className="score-card">
              <strong>{score}/{quiz.questions.length}</strong>
              <span>{score === quiz.questions.length ? '완벽해요! 책의 내용을 아주 잘 기억하고 있어요.' : '잘했어요! 틀린 문제를 책에서 다시 찾아보세요.'}</span>
            </section>
          )}

          <section className="quiz-list">
            {quiz.questions.map((question, index) => {
              const isCorrect = submitted && answers[index] === question.answer;
              return (
                <article className={`question-card ${submitted ? (isCorrect ? 'correct' : 'wrong') : ''}`} key={`${question.question}-${index}`}>
                  <div className="question-number">{String(index + 1).padStart(2, '0')}</div>
                  <h2>{question.question}</h2>
                  <div className="options-list">
                    {question.options.map((option, optionIndex) => (
                      <button
                        key={option}
                        className={answers[index] === optionIndex ? 'selected' : ''}
                        onClick={() => !submitted && setAnswers((prev) => ({ ...prev, [index]: optionIndex }))}
                        disabled={submitted}
                      >
                        <span>{optionIndex + 1}</span>{option}
                      </button>
                    ))}
                  </div>
                  {submitted && (
                    <div className="answer-feedback">
                      {isCorrect ? <CheckCircle2 size={19} /> : <XCircle size={19} />}
                      <div><strong>{isCorrect ? '정답이에요' : `정답은 ${question.answer + 1}번이에요`}</strong><p>{question.explanation}</p></div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          <div className="quiz-bottom-actions">
            {!submitted ? (
              <button className="primary quiz-submit" disabled={Object.keys(answers).length !== quiz.questions.length} onClick={() => setSubmitted(true)}>채점하기</button>
            ) : (
              <button className="secondary" onClick={() => { setAnswers({}); setSubmitted(false); }}><RotateCcw size={17} /> 다시 풀기</button>
            )}
            <button className="secondary" onClick={generateQuiz} disabled={loading}><RefreshCw size={17} /> 문제 다시 출제하기</button>
          </div>
          {error && <p className="quiz-error">{error}</p>}
        </main>
      </div>
    );
  }

  return (
    <div className="quiz-page">
      <header className="quiz-header">
        <button className="quiz-back" onClick={onBack}><ArrowLeft size={18} /> 추천도서로</button>
        <div className="eyebrow"><Sparkles size={15} /> 읽고 나서 기억을 꺼내보는 시간</div>
        <h1>책 한 권,<br /><span>퀴즈로 한 번 더</span></h1>
        <p>학년과 책 이름, 저자만 입력하면 아이 수준에 맞는 객관식 독서퀴즈를 만들어 줍니다.</p>
      </header>

      <main className="quiz-main">
        <section className="quiz-form-card">
          <label><span>학년</span><select value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })}>{GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label>
          <label><span>책 이름</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="예: 이상한 엄마" /></label>
          <label><span>저자</span><input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} placeholder="예: 백희나" /></label>
          <fieldset><legend>문제 수</legend><div className="count-options">{COUNTS.map((count) => <button type="button" className={form.count === count ? 'active' : ''} key={count} onClick={() => setForm({ ...form, count })}>{count}문제</button>)}</div></fieldset>
          <button className="primary generate-button" onClick={generateQuiz} disabled={loading}>{loading ? <><LoaderCircle className="spin" size={18} /> 문제 만드는 중…</> : <><BookOpenCheck size={18} /> 퀴즈 만들기</>}</button>
          {error && <p className="quiz-error">{error}</p>}
          <p className="quiz-caution">AI가 책의 세부 내용을 잘못 기억할 수 있습니다. 이상한 문제가 나오면 ‘문제 다시 출제하기’를 눌러 주세요.</p>
        </section>
      </main>
    </div>
  );
}

export default function QuizHub() {
  const [view, setView] = useState('books');
  return (
    <>
      <nav className="top-category-nav">
        <button className={view === 'books' ? 'active' : ''} onClick={() => setView('books')}><BookOpenCheck size={17} /> 추천도서</button>
        <button className={view === 'quiz' ? 'active' : ''} onClick={() => setView('quiz')}><Sparkles size={17} /> 독서퀴즈</button>
      </nav>
      {view === 'books' ? <App /> : <QuizPage onBack={() => setView('books')} />}
    </>
  );
}
