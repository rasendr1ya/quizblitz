const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const app = express();
const server = http.createServer(app);
const PORT = 3000;
const GRPC_SERVER = 'localhost:50051';

app.use(express.static(path.join(__dirname, '../web')));

function loadProto(filename) {
  const definition = protoLoader.loadSync(
    path.join(__dirname, '../proto', filename),
    {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    }
  );
  return grpc.loadPackageDefinition(definition);
}

const quizProto = loadProto('quiz.proto');
const streamProto = loadProto('stream.proto');
const adminProto = loadProto('admin.proto');

const quizClient = new quizProto.quiz.QuizService(
  GRPC_SERVER,
  grpc.credentials.createInsecure()
);
const streamClient = new streamProto.stream.StreamService(
  GRPC_SERVER,
  grpc.credentials.createInsecure()
);
const adminClient = new adminProto.admin.AdminService(
  GRPC_SERVER,
  grpc.credentials.createInsecure()
);

const sessionClients = new Map();
const clientMeta = new Map();
const streamSubs = new Map();
const sessionTimers = new Map();
const playerSessions = new Map();
const answerStats = new Map();
const sessionState = new Map();
const sessionPlayers = new Map();
const sessionSpectators = new Map();
const sessionAnsweredPlayers = new Map();
const quizCodeToSessionId = new Map();
const playerStats = new Map();

function getPlayerList(sessionId) {
  const players = sessionPlayers.get(sessionId);
  if (!players) return [];
  return Array.from(players).sort();
}

function getSpectatorCount(sessionId) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return 0;
  let count = 0;
  for (const ws of clients) {
    const meta = clientMeta.get(ws);
    if (meta && meta.role === 'spectator') count++;
  }
  return count;
}

function isSpectator(sessionId, playerName) {
  const spectators = sessionSpectators.get(sessionId);
  return spectators ? spectators.has(playerName) : false;
}

function filterLeaderboardEntries(sessionId, entries) {
  const spectators = sessionSpectators.get(sessionId);
  if (!spectators || spectators.size === 0) return entries;
  return entries.filter(e => !spectators.has(e.player_name));
}

function broadcastPlayerList(sessionId) {
  const players = getPlayerList(sessionId);
  broadcastToSession(sessionId, 'PLAYER_LIST_UPDATE', {
    players,
    count: players.length
  });
}

function sendToClient(ws, type, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcastToSession(sessionId, type, payload) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) {
    sendToClient(ws, type, payload);
  }
}

function sendToSessionExcept(sessionId, excludeWs, type, payload) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) {
    if (ws !== excludeWs) {
      sendToClient(ws, type, payload);
    }
  }
}

function sendToHost(sessionId, type, payload) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) {
    const meta = clientMeta.get(ws);
    if (meta && meta.role === 'host') {
      sendToClient(ws, type, payload);
    }
  }
}

function addClientToSession(ws, sessionId) {
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Set());
  }
  sessionClients.get(sessionId).add(ws);
}

function countPlayersInSession(sessionId) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return 0;
  let count = 0;
  for (const ws of clients) {
    const meta = clientMeta.get(ws);
    if (meta && meta.role === 'player') count++;
  }
  return count;
}

function removeClientFromSession(ws) {
  const meta = clientMeta.get(ws);
  if (!meta) {
    ws.isSpectator = false;
    ws.isHost = false;
    ws.playerName = undefined;
    ws.sessionId = undefined;
    return;
  }
  const { session_id: sessionId, player_name: playerName, role } = meta;
  const clients = sessionClients.get(sessionId);
  if (clients) {
    clients.delete(ws);
    if (clients.size === 0) {
      cancelStreamSubscription(sessionId);
      clearSessionTimer(sessionId);
      sessionClients.delete(sessionId);
      sessionState.delete(sessionId);
      answerStats.delete(sessionId);
      sessionPlayers.delete(sessionId);
      sessionSpectators.delete(sessionId);
      sessionAnsweredPlayers.delete(sessionId);
      playerStats.delete(sessionId);
    } else {
      const stats = answerStats.get(sessionId);
      if (stats) {
        stats.total = countPlayersInSession(sessionId);
      }

      if (role === 'player' && playerName) {
        const players = sessionPlayers.get(sessionId);
        if (players) {
          players.delete(playerName);
          broadcastPlayerList(sessionId);
        }
        const answered = sessionAnsweredPlayers.get(sessionId);
        if (answered) {
          answered.delete(playerName);
        }
      }

      if (role === 'spectator') {
        const spectatorName = meta.spectator_name || meta.player_name || '';
        const spectators = sessionSpectators.get(sessionId);
        if (spectators) {
          spectators.delete(spectatorName);
        }
        sendToHost(sessionId, 'SPECTATOR_LEFT', {
          name: spectatorName,
          count: getSpectatorCount(sessionId)
        });
      }
    }
  }
  clientMeta.delete(ws);
  ws.isSpectator = false;
  ws.isHost = false;
  ws.playerName = undefined;
  ws.sessionId = undefined;
}

function startSessionTimer(sessionId, timeLimit) {
  clearSessionTimer(sessionId);
  const state = { remaining: timeLimit, total: timeLimit };

  broadcastToSession(sessionId, 'TIMER_TICK', { remaining: state.remaining });

  state.interval = setInterval(() => {
    state.remaining--;
    if (state.remaining <= 0) {
      state.remaining = 0;
      broadcastToSession(sessionId, 'TIMER_TICK', { remaining: 0 });
      broadcastToSession(sessionId, 'TIMER_EXPIRED', {});

      const answered = sessionAnsweredPlayers.get(sessionId);
      const allPlayers = getPlayerList(sessionId);
      const pStats = playerStats.get(sessionId);
      if (answered && pStats) {
        for (const name of allPlayers) {
          if (!answered.has(name)) {
            const ps = pStats.get(name);
            if (ps) {
              ps.unanswered++;
            }
          }
        }
      }

      clearInterval(state.interval);
      sessionTimers.delete(sessionId);
    } else {
      broadcastToSession(sessionId, 'TIMER_TICK', { remaining: state.remaining });
    }
  }, 1000);

  sessionTimers.set(sessionId, state);
}

function clearSessionTimer(sessionId) {
  const state = sessionTimers.get(sessionId);
  if (state) {
    clearInterval(state.interval);
    sessionTimers.delete(sessionId);
  }
}

function resetAnswerStats(sessionId) {
  const total = countPlayersInSession(sessionId);
  answerStats.set(sessionId, { total, answered: 0 });
  sessionAnsweredPlayers.set(sessionId, new Set());

  sendToHost(sessionId, 'ANSWER_STATS', {
    answered: 0,
    total,
    percent: total > 0 ? 0 : 0
  });

  const players = getPlayerList(sessionId);
  broadcastToSession(sessionId, 'PEER_ANSWER_STATUS', {
    answeredPlayers: [],
    pendingPlayers: players
  });
}

function initPlayerStats(sessionId, playerName) {
  if (!playerStats.has(sessionId)) {
    playerStats.set(sessionId, new Map());
  }
  const sessionMap = playerStats.get(sessionId);
  if (!sessionMap.has(playerName)) {
    sessionMap.set(playerName, { correct: 0, wrong: 0, unanswered: 0 });
  }
}

function buildLeaderboardEntries(sessionId) {
  const players = getPlayerList(sessionId);
  const statsMap = playerStats.get(sessionId) || new Map();
  const lastLb = (sessionState.get(sessionId) || {}).lastLeaderboard;
  const lbEntries = lastLb ? lastLb.entries : [];

  const scoreMap = new Map();
  for (const e of lbEntries) {
    if (!isSpectator(sessionId, e.player_name)) {
      scoreMap.set(e.player_name, e.score);
    }
  }

  const entries = players.map((name) => {
    const s = statsMap.get(name) || { correct: 0, wrong: 0, unanswered: 0 };
    return {
      player_name: name,
      score: scoreMap.get(name) || 0,
      correct: s.correct,
      wrong: s.wrong,
      unanswered: s.unanswered
    };
  });

  entries.sort((a, b) => b.score - a.score);
  for (let i = 0; i < entries.length; i++) {
    entries[i].rank = i + 1;
  }

  return entries;
}

function subscribeStreamsForSession(sessionId) {
  if (streamSubs.has(sessionId)) return;

  const eventStream = streamClient.watchQuizEvents({
    session_id: sessionId,
    player_id: ''
  });
  const leaderboardStream = streamClient.watchLeaderboard({
    session_id: sessionId,
    player_id: ''
  });

  eventStream.on('data', async (event) => {
    if (event.type === 'TIMER_TICK') return;

    const payload = {
      type: event.type,
      question: event.question
        ? {
            question_id: event.question.question_id,
            text: event.question.text,
            options: event.question.options,
            time_limit: event.question.time_limit,
            question_number: event.question.question_number,
            total_questions: event.question.total_questions
          }
        : null,
      message: event.message,
      timer_remaining: event.timer_remaining,
      correct_answer: event.correct_answer
    };

    broadcastToSession(sessionId, 'QUIZ_EVENT', payload);

    if (event.type === 'QUESTION_START') {
      const questionData = payload.question;
      const timeLimit = questionData ? (questionData.time_limit || 15) : 15;

      const state = sessionState.get(sessionId) || {};
      state.currentQuestion = questionData;
      state.quizStatus = 'active';
      sessionState.set(sessionId, state);

      startSessionTimer(sessionId, timeLimit);
      resetAnswerStats(sessionId);
    }

    if (event.type === 'ANSWER_REVEAL') {
      clearSessionTimer(sessionId);
    }

    if (event.type === 'PLAYER_JOINED') {
      broadcastToSession(sessionId, 'PLAYER_JOINED', {
        message: event.message
      });

      const s = answerStats.get(sessionId);
      const st = sessionState.get(sessionId);
      if (s) {
        s.total = countPlayersInSession(sessionId);
        if (s.total > 0 && st && st.quizStatus === 'active') {
          sendToHost(sessionId, 'ANSWER_STATS', {
            answered: s.answered,
            total: s.total,
            percent: Math.round((s.answered / s.total) * 100)
          });
        }
      }
    }

    if (event.type === 'QUIZ_END') {
      clearSessionTimer(sessionId);
      const state = sessionState.get(sessionId) || {};
      state.quizStatus = 'ended';
      state.currentQuestion = null;
      sessionState.set(sessionId, state);

      const gwEntries = buildLeaderboardEntries(sessionId);

      let leaderboardEntries = [];
      let winnerName = '';

      try {
        const result = await unaryCall(quizClient, 'getQuizResult', { session_id: sessionId });
        const grpcMap = new Map();
        for (const entry of result.leaderboard) {
          grpcMap.set(entry.player_name, entry.correct_answers);
        }
        leaderboardEntries = gwEntries.map((e) => ({
          rank: e.rank,
          player_name: e.player_name,
          score: e.score,
          correct_answers: grpcMap.has(e.player_name) ? grpcMap.get(e.player_name) : e.correct,
          wrong: e.wrong,
          unanswered: e.unanswered
        }));
        winnerName = result.winner_name || (leaderboardEntries.length > 0 ? leaderboardEntries[0].player_name : '');
      } catch (e) {
        leaderboardEntries = gwEntries.map((e) => ({
          rank: e.rank,
          player_name: e.player_name,
          score: e.score,
          correct_answers: e.correct,
          wrong: e.wrong,
          unanswered: e.unanswered
        }));
        winnerName = leaderboardEntries.length > 0 ? leaderboardEntries[0].player_name : '';
      }

      broadcastToSession(sessionId, 'QUIZ_ENDED', {
        message: event.message,
        leaderboard: leaderboardEntries,
        winner: winnerName
      });
    }
  });

  leaderboardStream.on('data', (update) => {
    const rawEntries = update.entries.map((e) => ({
      player_name: e.player_name,
      score: e.score,
      rank: e.rank
    }));

    const statsMap = playerStats.get(sessionId) || new Map();
    const enrichedEntries = rawEntries.map((e) => {
      const ps = statsMap.get(e.player_name) || { correct: 0, wrong: 0, unanswered: 0 };
      return {
        player_name: e.player_name,
        score: e.score,
        rank: e.rank,
        correct: ps.correct,
        wrong: ps.wrong,
        unanswered: ps.unanswered
      };
    });

    const filteredEntries = filterLeaderboardEntries(sessionId, enrichedEntries);
    const recalcedEntries = filteredEntries.map((e, i) => ({
      ...e,
      rank: i + 1
    }));

    const lbData = {
      entries: recalcedEntries,
      triggered_by: update.triggered_by
    };

    const state = sessionState.get(sessionId) || {};
    state.lastLeaderboard = { entries: rawEntries.filter(e => !isSpectator(sessionId, e.player_name)) };
    sessionState.set(sessionId, state);

    broadcastToSession(sessionId, 'LEADERBOARD_UPDATE', lbData);
  });

  eventStream.on('error', (err) => {
    if (err.code !== grpc.status.CANCELLED) {
      console.error('Event stream error:', err.message);
    }
  });

  leaderboardStream.on('error', (err) => {
    if (err.code !== grpc.status.CANCELLED) {
      console.error('Leaderboard stream error:', err.message);
    }
  });

  eventStream.on('end', () => {
    cleanupStreamSubscription(sessionId);
  });

  streamSubs.set(sessionId, { eventStream, leaderboardStream });
  console.log(`Stream subscribed for session ${sessionId}`);
}

function cancelStreamSubscription(sessionId) {
  const sub = streamSubs.get(sessionId);
  if (!sub) return;
  try {
    sub.eventStream.cancel();
  } catch (e) { /* ignore */ }
  try {
    sub.leaderboardStream.cancel();
  } catch (e) { /* ignore */ }
  streamSubs.delete(sessionId);
  console.log(`Stream cancelled for session ${sessionId}`);
}

function cleanupStreamSubscription(sessionId) {
  streamSubs.delete(sessionId);
}

function unaryCall(client, method, payload) {
  return new Promise((resolve, reject) => {
    client[method](payload, (err, response) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(response);
    });
  });
}

async function handleCreateQuiz(ws, payload) {
  const response = await unaryCall(quizClient, 'createQuiz', {
    host_name: payload.host_name
  });

  clientMeta.set(ws, {
    session_id: response.session_id,
    quiz_code: response.quiz_code,
    host_id: response.host_id,
    role: 'host',
    player_id: null,
    player_name: payload.host_name
  });

  ws.isHost = true;
  ws.sessionId = response.session_id;

  addClientToSession(ws, response.session_id);
  subscribeStreamsForSession(response.session_id);

  const state = sessionState.get(response.session_id) || {};
  state.quizStatus = 'waiting';
  sessionState.set(response.session_id, state);

  if (!sessionPlayers.has(response.session_id)) {
    sessionPlayers.set(response.session_id, new Set());
  }

  quizCodeToSessionId.set(response.quiz_code.toUpperCase(), response.session_id);

  sendToClient(ws, 'QUIZ_CREATED', {
    quiz_code: response.quiz_code,
    session_id: response.session_id,
    host_id: response.host_id
  });
}

async function handleJoinQuiz(ws, payload) {
  const response = await unaryCall(quizClient, 'joinQuiz', {
    quiz_code: payload.quiz_code,
    player_name: payload.player_name
  });

  const sessionId = response.session_id;
  const sessionKey = `${payload.player_name}:${payload.quiz_code.toUpperCase()}`;

  clientMeta.set(ws, {
    session_id: sessionId,
    quiz_code: payload.quiz_code,
    host_id: null,
    role: 'player',
    player_id: response.player_id,
    player_name: payload.player_name
  });

  ws.isSpectator = false;
  ws.playerName = payload.player_name;
  ws.sessionId = sessionId;

  addClientToSession(ws, sessionId);
  subscribeStreamsForSession(sessionId);

  if (!sessionPlayers.has(sessionId)) {
    sessionPlayers.set(sessionId, new Set());
  }
  sessionPlayers.get(sessionId).add(payload.player_name);

  initPlayerStats(sessionId, payload.player_name);

  playerSessions.set(sessionKey, {
    sessionId,
    quizCode: payload.quiz_code.toUpperCase(),
    playerName: payload.player_name,
    playerId: response.player_id,
    lastScore: 0
  });

  quizCodeToSessionId.set(payload.quiz_code.toUpperCase(), sessionId);

  const stats = answerStats.get(sessionId);
  if (stats) {
    stats.total = countPlayersInSession(sessionId);
  }

  broadcastPlayerList(sessionId);

  sendToClient(ws, 'JOIN_SUCCESS', {
    player_id: response.player_id,
    session_id: response.session_id,
    status: response.status
  });
}

function handleJoinAsSpectator(ws, payload) {
  const quizCode = payload.quiz_code.toUpperCase();
  const sessionId = quizCodeToSessionId.get(quizCode);

  if (!sessionId) {
    sendToClient(ws, 'ERROR', { message: 'Quiz code tidak ditemukan' });
    return;
  }

  const state = sessionState.get(sessionId);
  if (!state) {
    sendToClient(ws, 'ERROR', { message: 'Session tidak ditemukan' });
    return;
  }

  const spectatorName = payload.name || 'Spectator';

  clientMeta.set(ws, {
    session_id: sessionId,
    quiz_code: payload.quiz_code,
    host_id: null,
    role: 'spectator',
    player_id: null,
    player_name: spectatorName,
    spectator_name: spectatorName
  });

  ws.isSpectator = true;
  ws.playerName = spectatorName;
  ws.sessionId = sessionId;

  addClientToSession(ws, sessionId);
  subscribeStreamsForSession(sessionId);

  if (!sessionSpectators.has(sessionId)) {
    sessionSpectators.set(sessionId, new Set());
  }
  sessionSpectators.get(sessionId).add(spectatorName);

  const timerData = sessionTimers.get(sessionId);
  const players = getPlayerList(sessionId);
  const rawLeaderboard = state.lastLeaderboard ? state.lastLeaderboard.entries : [];
  const leaderboard = filterLeaderboardEntries(sessionId, rawLeaderboard);

  sendToClient(ws, 'SPECTATOR_JOIN_SUCCESS', {
    quiz_code: payload.quiz_code,
    players,
    leaderboard,
    quiz_status: state.quizStatus || 'waiting',
    current_question: state.currentQuestion || null,
    timer_remaining: timerData ? timerData.remaining : null
  });

  sendToHost(sessionId, 'SPECTATOR_JOINED', {
    name: spectatorName,
    count: getSpectatorCount(sessionId)
  });
}

async function handleSubmitAnswer(ws, payload) {
  const meta = clientMeta.get(ws);

  if (meta && meta.role === 'spectator') {
    sendToClient(ws, 'ERROR', { message: 'Spectators cannot submit answers' });
    return;
  }

  const response = await unaryCall(quizClient, 'submitAnswer', {
    player_id: payload.player_id,
    session_id: payload.session_id,
    question_id: payload.question_id,
    answer: payload.answer,
    submitted_at: payload.submitted_at || Date.now()
  });

  sendToClient(ws, 'ANSWER_RESULT', {
    correct: response.correct,
    score_gained: response.score_gained,
    total_score: response.total_score
  });

  if (meta) {
    const sessionId = meta.session_id;
    const playerName = meta.player_name || '';

    const stats = answerStats.get(sessionId);
    if (stats) {
      stats.answered++;
      sendToHost(sessionId, 'ANSWER_STATS', {
        answered: stats.answered,
        total: stats.total,
        percent: stats.total > 0 ? Math.round((stats.answered / stats.total) * 100) : 0
      });
    }

    const answered = sessionAnsweredPlayers.get(sessionId);
    if (answered && playerName) {
      answered.add(playerName);
    }

    const allPlayers = getPlayerList(sessionId);
    const answeredList = Array.from(answered || []);
    const pendingList = allPlayers.filter(name => !answeredList.includes(name));

    broadcastToSession(sessionId, 'PEER_ANSWER_STATUS', {
      answeredPlayers: answeredList,
      pendingPlayers: pendingList
    });

    const sessionKey = `${playerName}:${(meta.quiz_code || '').toUpperCase()}`;
    const stored = playerSessions.get(sessionKey);
    if (stored) {
      stored.lastScore = response.total_score;
    }

    const pStats = playerStats.get(sessionId);
    if (pStats && playerName) {
      const ps = pStats.get(playerName);
      if (ps) {
        if (response.correct) {
          ps.correct++;
        } else {
          ps.wrong++;
        }
      }
    }
  }
}

async function handleGetResult(ws, payload) {
  const response = await unaryCall(quizClient, 'getQuizResult', {
    session_id: payload.session_id
  });

  const meta = clientMeta.get(ws);
  const sessionId = meta ? meta.session_id : null;
  const statsMap = playerStats.get(sessionId) || new Map();

  const grpcLeaderboard = response.leaderboard.filter(e => !isSpectator(sessionId, e.player_name));
  const leaderboard = grpcLeaderboard.map((entry, i) => {
    const ps = statsMap.get(entry.player_name) || { correct: 0, wrong: 0, unanswered: 0 };
    return {
      rank: i + 1,
      player_name: entry.player_name,
      score: entry.score,
      correct_answers: entry.correct_answers,
      wrong: ps.wrong,
      unanswered: ps.unanswered
    };
  });

  sendToClient(ws, 'QUIZ_RESULT', {
    leaderboard,
    winner_name: leaderboard.length > 0 ? leaderboard[0].player_name : response.winner_name
  });
}

function handleUploadQuestions(ws, payload) {
  return new Promise((resolve) => {
    const { session_id, host_id, questions } = payload;

    if (!session_id || !host_id || !Array.isArray(questions) || questions.length === 0) {
      sendToClient(ws, 'ERROR', {
        message: 'session_id, host_id, dan questions wajib diisi'
      });
      return resolve();
    }

    let settled = false;

    const finalize = (err, response) => {
      if (settled) return;
      settled = true;

      if (err) {
        sendToClient(ws, 'ERROR', {
          message: err.message || 'Upload gagal'
        });
        return resolve();
      }

      sendToClient(ws, 'UPLOAD_RESULT', {
        total_uploaded: response.total_uploaded,
        success: response.success,
        message: response.message
      });

      if (response.success) {
        const st = sessionState.get(session_id) || {};
        st.totalQuestions = (st.totalQuestions || 0) + questions.length;
        sessionState.set(session_id, st);
      }

      resolve();
    };

    const stream = adminClient.uploadQuestions((err, response) => finalize(err, response));
    stream.on('error', (err) => {
      if (!settled) finalize(err);
    });

    try {
      for (const q of questions) {
        stream.write({
          session_id,
          host_id,
          question_text: q.question_text,
          options: q.options,
          correct_answer: q.correct_answer,
          time_limit: q.time_limit || 20
        });
      }
      stream.end();
    } catch (err) {
      finalize(err);
    }
  });
}

async function handleControlQuiz(ws, payload) {
  const { action, session_id, host_id } = payload;

  if (!action || !session_id || !host_id) {
    sendToClient(ws, 'ERROR', {
      message: 'action, session_id, dan host_id wajib diisi'
    });
    return;
  }

  clearSessionTimer(session_id);

  const rpcPayload = { session_id, host_id };
  let method;
  switch (action) {
    case 'start':
      method = 'startQuiz';
      break;
    case 'next':
      method = 'nextQuestion';
      break;
    case 'end':
      method = 'endQuiz';
      break;
    default:
      sendToClient(ws, 'ERROR', {
        message: `Unknown action: ${action}. Gunakan start, next, atau end.`
      });
      return;
  }

  try {
    const response = await unaryCall(adminClient, method, rpcPayload);
    sendToClient(ws, 'CONTROL_RESULT', {
      success: response.success,
      message: response.message,
      action
    });
  } catch (err) {
    sendToClient(ws, 'ERROR', {
      message: err.message || 'Control quiz gagal'
    });
  }
}

function handleLeaveQuiz(ws, payload) {
  const meta = clientMeta.get(ws);
  if (!meta) {
    sendToClient(ws, 'ERROR', { message: 'Tidak tergabung dalam session' });
    return;
  }

  const { session_id: sessionId, quiz_code: quizCode } = meta;
  const playerName = payload.player_name || (meta.player_name || '');

  if (meta.role === 'player' && playerName) {
    const players = sessionPlayers.get(sessionId);
    if (players) {
      players.delete(playerName);
    }
    const answered = sessionAnsweredPlayers.get(sessionId);
    if (answered) {
      answered.delete(playerName);
    }
  }

  broadcastToSession(sessionId, 'PLAYER_LEFT', {
    player_name: playerName,
    message: `${playerName} keluar dari quiz`
  });

  if (playerName && quizCode && meta.role === 'player') {
    const sessionKey = `${playerName}:${quizCode.toUpperCase()}`;
    playerSessions.delete(sessionKey);
  }

  removeClientFromSession(ws);

  broadcastPlayerList(sessionId);

  sendToClient(ws, 'LEAVE_CONFIRMED', { message: 'Berhasil keluar dari quiz' });
}

function handleRejoinQuiz(ws, payload) {
  const sessionKey = `${payload.name}:${payload.quiz_code.toUpperCase()}`;
  const stored = playerSessions.get(sessionKey);

  if (!stored) {
    sendToClient(ws, 'ERROR', { message: 'Session not found, please join as a new player' });
    return;
  }

  clientMeta.set(ws, {
    session_id: stored.sessionId,
    quiz_code: stored.quizCode,
    host_id: null,
    role: 'player',
    player_id: stored.playerId,
    player_name: stored.playerName
  });

  ws.isSpectator = false;
  ws.playerName = stored.playerName;
  ws.sessionId = stored.sessionId;

  addClientToSession(ws, stored.sessionId);
  subscribeStreamsForSession(stored.sessionId);

  if (!sessionPlayers.has(stored.sessionId)) {
    sessionPlayers.set(stored.sessionId, new Set());
  }
  sessionPlayers.get(stored.sessionId).add(stored.playerName);

  initPlayerStats(stored.sessionId, stored.playerName);

  const state = sessionState.get(stored.sessionId) || {};
  const timerData = sessionTimers.get(stored.sessionId);

  const stats = answerStats.get(stored.sessionId);
  if (stats) {
    stats.total = countPlayersInSession(stored.sessionId);
  }

  broadcastPlayerList(stored.sessionId);

  sendToClient(ws, 'REJOIN_SUCCESS', {
    player_id: stored.playerId,
    session_id: stored.sessionId,
    quiz_code: stored.quizCode,
    player_name: stored.playerName,
    quiz_status: state.quizStatus || 'waiting',
    current_question: state.currentQuestion || null,
    timer_remaining: timerData ? timerData.remaining : null,
    leaderboard: state.lastLeaderboard ? state.lastLeaderboard.entries : [],
    last_score: stored.lastScore
  });

  broadcastToSession(stored.sessionId, 'PLAYER_REJOINED', {
    player_name: stored.playerName,
    message: `${stored.playerName} kembali bergabung`
  });
}

function handleKickPlayer(ws, payload) {
  const meta = clientMeta.get(ws);
  if (!meta || meta.role !== 'host') {
    sendToClient(ws, 'ERROR', { message: 'Only the host can kick players' });
    return;
  }

  const { quiz_code, playerName } = payload;
  const sessionId = meta.session_id;
  const clients = sessionClients.get(sessionId);
  if (!clients) {
    sendToClient(ws, 'ERROR', { message: 'Session not found' });
    return;
  }

  let targetWs = null;
  let targetMeta = null;

  for (const client of clients) {
    const cm = clientMeta.get(client);
    if (cm && cm.role === 'player' && cm.player_name === playerName) {
      targetWs = client;
      targetMeta = cm;
      break;
    }
  }

  if (!targetWs) {
    sendToClient(ws, 'ERROR', { message: `Player "${playerName}" not found in session` });
    return;
  }

  sendToClient(targetWs, 'YOU_WERE_KICKED', {
    message: 'You have been removed from the quiz by the host.'
  });

  if (targetMeta) {
    const players = sessionPlayers.get(sessionId);
    if (players) {
      players.delete(playerName);
    }
    const answered = sessionAnsweredPlayers.get(sessionId);
    if (answered) {
      answered.delete(playerName);
    }
    const sessionKey = `${playerName}:${(targetMeta.quiz_code || '').toUpperCase()}`;
    playerSessions.delete(sessionKey);
  }

  targetWs.onclose = null;
  targetWs.close();

  clientMeta.delete(targetWs);

  if (clients.size - 1 <= 0) {
    cancelStreamSubscription(sessionId);
    clearSessionTimer(sessionId);
    sessionClients.delete(sessionId);
    sessionState.delete(sessionId);
    answerStats.delete(sessionId);
    sessionPlayers.delete(sessionId);
    sessionSpectators.delete(sessionId);
    sessionAnsweredPlayers.delete(sessionId);
    playerStats.delete(sessionId);
  } else {
    const stats = answerStats.get(sessionId);
    if (stats) {
      stats.total = countPlayersInSession(sessionId);
    }
  }

  broadcastToSession(sessionId, 'PLAYER_KICKED', {
    playerName
  });

  broadcastPlayerList(sessionId);
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendToClient(ws, 'ERROR', { message: 'Format pesan tidak valid' });
      return;
    }

    const { type, payload } = msg;

    try {
      switch (type) {
        case 'CREATE_QUIZ':
          await handleCreateQuiz(ws, payload);
          break;
        case 'JOIN_QUIZ':
          await handleJoinQuiz(ws, payload);
          break;
        case 'JOIN_AS_SPECTATOR':
          handleJoinAsSpectator(ws, payload);
          break;
        case 'SUBMIT_ANSWER':
          await handleSubmitAnswer(ws, payload);
          break;
        case 'GET_RESULT':
          await handleGetResult(ws, payload);
          break;
        case 'UPLOAD_QUESTIONS':
          await handleUploadQuestions(ws, payload);
          break;
        case 'CONTROL_QUIZ':
          await handleControlQuiz(ws, payload);
          break;
        case 'LEAVE_QUIZ':
          handleLeaveQuiz(ws, payload);
          break;
        case 'REJOIN_QUIZ':
          handleRejoinQuiz(ws, payload);
          break;
        case 'KICK_PLAYER':
          handleKickPlayer(ws, payload);
          break;
        default:
          sendToClient(ws, 'ERROR', {
            message: `Unknown command: ${type}`
          });
      }
    } catch (err) {
      sendToClient(ws, 'ERROR', {
        message: err.message || 'Internal gateway error'
      });
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    removeClientFromSession(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket Gateway running on http://localhost:${PORT}`);
});