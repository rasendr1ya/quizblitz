const grpc = require('@grpc/grpc-js');
const { v4: uuidv4 } = require('uuid');
const {
  buildLeaderboard,
  clearQuestionTimer,
  emitLeaderboard,
  getSessionById,
  normalizeAnswer,
  resetPlayersForNewQuiz,
  startQuestionTimer
} = require('../../state/store');

function authorizeHost(session_id, host_id) {
  if (!session_id || !host_id) {
    return {
      error: {
        code: grpc.status.INVALID_ARGUMENT,
        message: 'session_id dan host_id wajib diisi'
      }
    };
  }

  const session = getSessionById(session_id);
  if (!session) {
    return {
      error: {
        code: grpc.status.NOT_FOUND,
        message: 'Session tidak ditemukan'
      }
    };
  }

  if (session.host_id !== host_id) {
    return {
      error: {
        code: grpc.status.PERMISSION_DENIED,
        message: 'Bukan host yang sah'
      }
    };
  }

  return { session };
}

function formatQuestionPayload(session, question, index) {
  return {
    question_id: question.id,
    text: question.text,
    options: question.options,
    time_limit: question.time_limit,
    question_number: index + 1,
    total_questions: session.questions.length
  };
}

function beginQuestion(session, index) {
  const question = session.questions[index];
  session.current_idx = index;
  session.question_start_time = Date.now();
  session.last_revealed_question_id = null;

  session.emitter.emit('quiz_event', {
    type: 'QUESTION_START',
    question: formatQuestionPayload(session, question, index),
    message: `Soal ${index + 1} dimulai`
  });

  startQuestionTimer(session);
}

function uploadQuestions(call, callback) {
  let session = null;
  let authorized = false;
  let streamAborted = false;
  const questions = [];

  const abortStream = (error) => {
    if (streamAborted) {
      return;
    }
    streamAborted = true;
    call.destroy(error);
  };

  call.on('data', (chunk) => {
    if (streamAborted) {
      return;
    }

    if (!session) {
      const session_id = String(chunk.session_id || '').trim();
      const host_id = String(chunk.host_id || '').trim();
      const auth = authorizeHost(session_id, host_id);
      if (auth.error) {
        abortStream(auth.error);
        return;
      }

      session = auth.session;
      if (session.status !== 'waiting') {
        abortStream({
          code: grpc.status.FAILED_PRECONDITION,
          message: 'Soal hanya bisa diupload saat quiz masih menunggu dimulai'
        });
        return;
      }

      authorized = true;
    }

    const question_text = String(chunk.question_text || '').trim();
    const options = (chunk.options || []).map((option) => String(option || '').trim()).filter(Boolean);
    const correct_answer = normalizeAnswer(chunk.correct_answer);
    const time_limit = Number(chunk.time_limit) > 0 ? Number(chunk.time_limit) : 20;

    if (!question_text || options.length < 2 || !correct_answer) {
      return;
    }

    const optionIndex = correct_answer.charCodeAt(0) - 65;
    if (optionIndex < 0 || optionIndex >= options.length) {
      return;
    }

    questions.push({
      id: uuidv4(),
      text: question_text,
      options,
      correct_answer,
      time_limit
    });
  });

  call.on('end', () => {
    if (streamAborted) {
      return;
    }

    if (!authorized || !session || questions.length === 0) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Tidak ada soal valid yang diupload'
      });
    }

    clearQuestionTimer(session);
    session.questions = questions;
    session.current_idx = -1;
    session.question_start_time = null;
    session.last_revealed_question_id = null;
    resetPlayersForNewQuiz(session);
    emitLeaderboard(session, 'upload');

    return callback(null, {
      total_uploaded: questions.length,
      success: true,
      message: `${questions.length} soal berhasil diupload`
    });
  });

  call.on('error', (err) => {
    if (err && err.code !== grpc.status.CANCELLED) {
      console.error('Upload error:', err.message || err);
    }
  });
}

function startQuiz(call, callback) {
  const session_id = String(call.request.session_id || '').trim();
  const host_id = String(call.request.host_id || '').trim();
  const auth = authorizeHost(session_id, host_id);

  if (auth.error) {
    return callback(auth.error);
  }

  const { session } = auth;

  if (session.questions.length === 0) {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Belum ada soal yang diupload'
    });
  }

  if (session.status !== 'waiting') {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Quiz sudah dimulai atau telah selesai'
    });
  }

  session.status = 'active';
  beginQuestion(session, 0);
  emitLeaderboard(session, 'quiz_started');

  return callback(null, {
    success: true,
    message: 'Quiz dimulai'
  });
}

function nextQuestion(call, callback) {
  const session_id = String(call.request.session_id || '').trim();
  const host_id = String(call.request.host_id || '').trim();
  const auth = authorizeHost(session_id, host_id);

  if (auth.error) {
    return callback(auth.error);
  }

  const { session } = auth;

  if (session.status !== 'active') {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Quiz tidak sedang aktif'
    });
  }

  const previousQuestion = session.questions[session.current_idx];
  if (!previousQuestion) {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Tidak ada soal aktif untuk dilanjutkan'
    });
  }

  clearQuestionTimer(session);

  if (session.last_revealed_question_id !== previousQuestion.id) {
    session.last_revealed_question_id = previousQuestion.id;
    session.emitter.emit('quiz_event', {
      type: 'ANSWER_REVEAL',
      correct_answer: previousQuestion.correct_answer,
      message: `Jawaban: ${previousQuestion.correct_answer}`
    });
  }

  const nextIndex = session.current_idx + 1;
  if (nextIndex >= session.questions.length) {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Tidak ada soal berikutnya. Gunakan EndQuiz.'
    });
  }

  beginQuestion(session, nextIndex);

  return callback(null, {
    success: true,
    message: `Soal ${nextIndex + 1} dimulai`
  });
}

function endQuiz(call, callback) {
  const session_id = String(call.request.session_id || '').trim();
  const host_id = String(call.request.host_id || '').trim();
  const auth = authorizeHost(session_id, host_id);

  if (auth.error) {
    return callback(auth.error);
  }

  const { session } = auth;

  if (session.status === 'ended') {
    return callback({
      code: grpc.status.FAILED_PRECONDITION,
      message: 'Quiz sudah berakhir'
    });
  }

  clearQuestionTimer(session);

  const currentQuestion = session.questions[session.current_idx];
  if (session.status === 'active' && currentQuestion && session.last_revealed_question_id !== currentQuestion.id) {
    session.last_revealed_question_id = currentQuestion.id;
    session.emitter.emit('quiz_event', {
      type: 'ANSWER_REVEAL',
      correct_answer: currentQuestion.correct_answer,
      message: `Jawaban: ${currentQuestion.correct_answer}`
    });
  }

  session.status = 'ended';

  const leaderboard = buildLeaderboard(session);
  emitLeaderboard(session, 'final');
  session.emitter.emit('quiz_event', {
    type: 'QUIZ_END',
    message: `Quiz berakhir! Pemenang: ${leaderboard[0] ? leaderboard[0].player_name : 'N/A'}`
  });

  return callback(null, {
    success: true,
    message: 'Quiz berakhir'
  });
}

module.exports = {
  endQuiz,
  nextQuestion,
  startQuiz,
  uploadQuestions
};
