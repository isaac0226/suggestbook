import React from 'react';
import ReactDOM from 'react-dom/client';
import QuizHub from './QuizHub';
import './styles.css';
import './quiz-extra.css';
import './quiz-feedback.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QuizHub />
  </React.StrictMode>,
);
