const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

const store = {
  sessions: {}
};

function generateQuizCode() {
  let quizCode = '';
  do {
    quizCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (store.sessions[quizCode]);
  return quizCode;
}

function normalizeAnswer(answer) {
  return String(answer || '').trim().toUpperCase();
}

function createSession(host_name) {
  const session_id = uuidv4();
  const quiz_code = generateQuizCode();
  const host_id = uuidv4();

  store.sessions[quiz_code] = {
    session_id,
    quiz_code,
    host_id,
    host_name: String(host_name).trim(),
    status: 'waiting',
    questions: [],
    current_idx: -1,
    question_start_time: null,
    current_question_timer: null,
    last_revealed_question_id: null,
    players: {},
    emitter: new EventEmitter()
  };

  return { session_id, quiz_code, host_id };
}

function getSessionByCode(quiz_code) {
  return store.sessions[String(quiz_code || '').toUpperCase()] || null;
}

function getSessionById(session_id) {
  return Object.values(store.sessions).find((session) => session.session_id === session_id) || null;
}

function buildLeaderboard(session) {
  return Object.values(session.players)
    .map((player) => ({
      player_name: player.name,
      score: player.score,
      correct_answers: player.correct_answers
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.correct_answers !== a.correct_answers) {
        return b.correct_answers - a.correct_answers;
      }
      return a.player_name.localeCompare(b.player_name);
    })
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));
}

function clearQuestionTimer(session) {
  if (session.current_question_timer) {
    clearInterval(session.current_question_timer);
    session.current_question_timer = null;
  }
}

function emitLeaderboard(session, triggered_by) {
  const entries = buildLeaderboard(session).map((entry) => ({
    player_name: entry.player_name,
    score: entry.score,
    rank: entry.rank
  }));

  session.emitter.emit('leaderboard_update', {
    entries,
    triggered_by: triggered_by || 'system'
  });
}

function startQuestionTimer(session) {
  clearQuestionTimer(session);

  const question = session.questions[session.current_idx];
  if (!question || !session.question_start_time) {
    return;
  }

  let lastRemaining = question.time_limit;

  session.current_question_timer = setInterval(() => {
    if (session.status !== 'active') {
      clearQuestionTimer(session);
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - session.question_start_time) / 1000);
    const remaining = Math.max(question.time_limit - elapsedSeconds, 0);

    if (remaining === lastRemaining) {
      if (remaining === 0) {
        clearQuestionTimer(session);
      }
      return;
    }

    lastRemaining = remaining;
    session.emitter.emit('quiz_event', {
      type: 'TIMER_TICK',
      timer_remaining: remaining,
      message: remaining > 0 ? `${remaining} detik tersisa` : 'Waktu habis'
    });

    if (remaining === 0) {
      clearQuestionTimer(session);
    }
  }, 1000);
}

function resetPlayersForNewQuiz(session) {
  Object.values(session.players).forEach((player) => {
    player.score = 0;
    player.correct_answers = 0;
    player.answers = [];
  });
}

module.exports = {
  store,
  buildLeaderboard,
  clearQuestionTimer,
  createSession,
  emitLeaderboard,
  generateQuizCode,
  getSessionByCode,
  getSessionById,
  normalizeAnswer,
  resetPlayersForNewQuiz,
  startQuestionTimer
};
