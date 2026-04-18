const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const readline = require('readline');

const SERVER_ADDRESS = process.env.GRPC_SERVER || 'localhost:50051';

function loadProto(filename) {
  const definition = protoLoader.loadSync(path.join(__dirname, '../proto', filename), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  });

  return grpc.loadPackageDefinition(definition);
}

function unary(client, method, payload) {
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

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return null;
  }
  return process.argv[index + 1];
}

function formatGrpcError(err) {
  const statusName = Object.entries(grpc.status).find(([, value]) => value === err.code);
  const label = statusName ? statusName[0] : 'UNKNOWN';
  return `[${label}] ${err.details || err.message}`;
}

function printLeaderboard(update) {
  console.log('\n[LEADERBOARD]');
  if (!update.entries.length) {
    console.log('Belum ada skor yang tercatat.');
    return;
  }

  update.entries.forEach((entry) => {
    console.log(`#${entry.rank} ${entry.player_name}: ${entry.score} poin`);
  });
  if (update.triggered_by) {
    console.log(`Dipicu oleh: ${update.triggered_by}`);
  }
}

function printUsageAndExit() {
  console.error('Usage: node client/player_client.js --name "Nama" --code "ABC123"');
  process.exit(1);
}

async function runPlayer() {
  const player_name = getArgValue('--name');
  const quiz_code = getArgValue('--code');

  if (!player_name || !quiz_code) {
    printUsageAndExit();
  }

  const quizProto = loadProto('quiz.proto');
  const streamProto = loadProto('stream.proto');

  const quizClient = new quizProto.quiz.QuizService(
    SERVER_ADDRESS,
    grpc.credentials.createInsecure()
  );
  const streamClient = new streamProto.stream.StreamService(
    SERVER_ADDRESS,
    grpc.credentials.createInsecure()
  );

  const { player_id, session_id } = await unary(quizClient, 'joinQuiz', {
    quiz_code,
    player_name
  });

  console.log(`${player_name} berhasil join quiz ${quiz_code.toUpperCase()}`);
  console.log(`Player ID : ${player_id}`);
  console.log(`Session ID: ${session_id}`);
  console.log('Tunggu soal muncul, lalu jawab dengan huruf opsi dan tekan ENTER.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${player_name}> `
  });

  let currentQuestion = null;
  let ended = false;
  const answeredQuestions = new Set();
  let submitting = false;

  const eventStream = streamClient.watchQuizEvents({ session_id, player_id });
  const leaderboardStream = streamClient.watchLeaderboard({ session_id, player_id });

  eventStream.on('data', async (event) => {
    switch (event.type) {
      case 'QUESTION_START':
        currentQuestion = event.question;
        submitting = false;
        console.log(`\n[SOAL ${event.question.question_number}/${event.question.total_questions}]`);
        console.log(event.question.text);
        event.question.options.forEach((option, index) => {
          console.log(`  ${String.fromCharCode(65 + index)}. ${option}`);
        });
        console.log(`Waktu: ${event.question.time_limit} detik`);
        rl.prompt();
        break;
      case 'TIMER_TICK':
        if (
          event.timer_remaining === 0 ||
          event.timer_remaining <= 5 ||
          event.timer_remaining % 5 === 0
        ) {
          console.log(`[TIMER] ${event.message}`);
          if (event.timer_remaining === 0) {
            currentQuestion = null;
            submitting = false;
          }
          rl.prompt();
        }
        break;
      case 'ANSWER_REVEAL':
        console.log(`[JAWABAN] Jawaban benar: ${event.correct_answer}`);
        currentQuestion = null;
        submitting = false;
        rl.prompt();
        break;
      case 'PLAYER_JOINED':
        console.log(`[INFO] ${event.message}`);
        rl.prompt();
        break;
      case 'QUIZ_END':
        console.log(`[SELESAI] ${event.message}`);
        currentQuestion = null;
        ended = true;
        try {
          const result = await unary(quizClient, 'getQuizResult', { session_id });
          if (result.leaderboard.length) {
            console.log('\n[HASIL AKHIR]');
            result.leaderboard.forEach((entry, index) => {
              console.log(
                `${index + 1}. ${entry.player_name} - ${entry.score} poin (${entry.correct_answers} benar)`
              );
            });
            console.log(`Pemenang: ${result.winner_name || 'N/A'}`);
          }
        } catch (err) {
          console.error(formatGrpcError(err));
        }
        leaderboardStream.cancel();
        rl.close();
        break;
      default:
        break;
    }
  });

  eventStream.on('error', (err) => {
    if (!ended && err && err.code !== grpc.status.CANCELLED) {
      console.error('Event stream error:', formatGrpcError(err));
    }
  });

  leaderboardStream.on('data', (update) => {
    printLeaderboard(update);
    rl.prompt();
  });

  leaderboardStream.on('error', (err) => {
    if (!ended && err && err.code !== grpc.status.CANCELLED) {
      console.error('Leaderboard stream error:', formatGrpcError(err));
    }
  });

  rl.prompt();

  rl.on('line', async (input) => {
    const answer = String(input || '').trim().toUpperCase();

    if (ended) {
      return;
    }

    if (!currentQuestion) {
      console.log('Belum ada soal aktif untuk dijawab.');
      rl.prompt();
      return;
    }

    if (!answer) {
      console.log('Masukkan huruf jawaban, misalnya A atau B.');
      rl.prompt();
      return;
    }

    if (answeredQuestions.has(currentQuestion.question_id)) {
      console.log('Jawaban untuk soal ini sudah dikirim.');
      rl.prompt();
      return;
    }

    if (submitting) {
      console.log('Pengiriman jawaban masih diproses.');
      rl.prompt();
      return;
    }

    submitting = true;

    try {
      const response = await unary(quizClient, 'submitAnswer', {
        player_id,
        session_id,
        question_id: currentQuestion.question_id,
        answer,
        submitted_at: Date.now()
      });
      answeredQuestions.add(currentQuestion.question_id);
      console.log(
        response.correct
          ? `[BENAR] +${response.score_gained} poin | Total: ${response.total_score}`
          : `[SALAH] +0 poin | Total: ${response.total_score}`
      );
    } catch (err) {
      console.error(formatGrpcError(err));
    } finally {
      submitting = false;
      rl.prompt();
    }
  });

  rl.on('close', () => {
    eventStream.cancel();
    leaderboardStream.cancel();
    process.exit(0);
  });
}

runPlayer().catch((err) => {
  console.error('Player client gagal:', formatGrpcError(err));
  process.exit(1);
});
