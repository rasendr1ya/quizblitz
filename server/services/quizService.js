const grpc = require('@grpc/grpc-js');
const { v4: uuidv4 } = require('uuid');
const {
  buildLeaderboard,
  createSession,
  emitLeaderboard,
  getSessionByCode,
  getSessionById,
  normalizeAnswer
} = require('../../state/store');

function createQuiz(call, callback) {
  const host_name = String(call.request.host_name || '').trim();

  if (!host_name) {
    return callback({
      code: grpc.status.INVALID_ARGUMENT,
      message: 'host_name wajib diisi'
    });
  }

  const result = createSession(host_name);
  return callback(null, result);
}

function joinQuiz(call, callback) {
  const quiz_code = String(call.request.quiz_code || '').trim().toUpperCase();
  const player_name = String(call.request.player_name || '').trim();

  if (!quiz_code) {
    return callback({
      code: grpc.status.INVALID_ARGUMENT,
      message: 'quiz_code wajib diisi'
    });
  }

  if (!player_name) {
    return callback({
      code: grpc.status.INVALID_ARGUMENT,
      message: 'player_name wajib diisi'
    });
  }

  const session = getSessionByCode(quiz_code);
  if (!session) {
    return callback({
      code: grpc.status.NOT_FOUND,
      message: `Quiz ${quiz_code} tidak ditemukan`
    });
  }

  if (session.status !== 'waiting') {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Quiz sudah berjalan atau telah selesai, tidak bisa join'
    });
  }

  const duplicate = Object.values(session.players).find(
    (player) => player.name.toLowerCase() === player_name.toLowerCase()
  );
  if (duplicate) {
    return callback({
      code: grpc.status.ALREADY_EXISTS,
      message: `Nama ${player_name} sudah digunakan`
    });
  }

  const player_id = uuidv4();
  session.players[player_id] = {
    name: player_name,
    score: 0,
    correct_answers: 0,
    answers: []
  };

  session.emitter.emit('quiz_event', {
    type: 'PLAYER_JOINED',
    message: `${player_name} bergabung ke kuis`
  });
  emitLeaderboard(session, player_name);

  return callback(null, {
    player_id,
    session_id: session.session_id,
    status: 'joined'
  });
}

function submitAnswer(call, callback) {
  const session_id = String(call.request.session_id || '').trim();
  const player_id = String(call.request.player_id || '').trim();
  const question_id = String(call.request.question_id || '').trim();
  const answer = normalizeAnswer(call.request.answer);
  const submitted_at = Number(call.request.submitted_at) || Date.now();

  if (!session_id || !player_id || !question_id || !answer) {
    return callback({
      code: grpc.status.INVALID_ARGUMENT,
      message: 'session_id, player_id, question_id, dan answer wajib diisi'
    });
  }

  const session = getSessionById(session_id);
  if (!session) {
    return callback({
      code: grpc.status.NOT_FOUND,
      message: 'Session tidak ditemukan'
    });
  }

  if (session.status !== 'active') {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Quiz tidak sedang aktif'
    });
  }

  const player = session.players[player_id];
  if (!player) {
    return callback({
      code: grpc.status.NOT_FOUND,
      message: 'Player tidak terdaftar'
    });
  }

  const currentQuestion = session.questions[session.current_idx];
  if (!currentQuestion) {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Belum ada soal aktif'
    });
  }

  if (currentQuestion.id !== question_id) {
    return callback({
      code: grpc.status.INVALID_ARGUMENT,
      message: 'question_id tidak sesuai dengan soal yang sedang aktif'
    });
  }

  const alreadyAnswered = player.answers.find((entry) => entry.question_id === question_id);
  if (alreadyAnswered) {
    return callback({
      code: grpc.status.ALREADY_EXISTS,
      message: 'Jawaban untuk soal ini sudah dikirim sebelumnya'
    });
  }

  const timeElapsed = (Date.now() - session.question_start_time) / 1000;
  if (timeElapsed > currentQuestion.time_limit) {
    return callback({
      code: grpc.status.DEADLINE_EXCEEDED,
      message: 'Waktu menjawab sudah habis'
    });
  }

  const correct = answer === normalizeAnswer(currentQuestion.correct_answer);
  const score_gained = correct ? Math.max(100 - Math.floor(timeElapsed) * 5, 10) : 0;

  player.score += score_gained;
  if (correct) {
    player.correct_answers += 1;
  }

  player.answers.push({
    question_id,
    answer,
    correct,
    score_gained,
    submitted_at
  });

  emitLeaderboard(session, player.name);

  return callback(null, {
    correct,
    score_gained,
    total_score: player.score
  });
}

function getQuizResult(call, callback) {
  const session_id = String(call.request.session_id || '').trim();
  if (!session_id) {
    return callback({
      code: grpc.status.INVALID_ARGUMENT,
      message: 'session_id wajib diisi'
    });
  }

  const session = getSessionById(session_id);
  if (!session) {
    return callback({
      code: grpc.status.NOT_FOUND,
      message: 'Session tidak ditemukan'
    });
  }

  const leaderboard = buildLeaderboard(session).map((entry) => ({
    player_name: entry.player_name,
    score: entry.score,
    correct_answers: entry.correct_answers
  }));

  return callback(null, {
    leaderboard,
    winner_name: leaderboard[0] ? leaderboard[0].player_name : ''
  });
}

module.exports = {
  createQuiz,
  getQuizResult,
  joinQuiz,
  submitAnswer
};
