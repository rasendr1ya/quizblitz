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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function uploadQuestions(adminClient, session_id, host_id, questions) {
  return new Promise(async (resolve, reject) => {
    let settled = false;

    const finalize = (err, response) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve(response);
    };

    const stream = adminClient.uploadQuestions((err, response) => finalize(err, response));
    stream.on('error', (err) => finalize(err));

    try {
      for (const question of questions) {
        stream.write({
          session_id,
          host_id,
          ...question
        });
        await delay(100);
      }
      stream.end();
    } catch (err) {
      finalize(err);
    }
  });
}

function printFinalResult(result) {
  console.log('\n[HASIL AKHIR]');
  if (!result.leaderboard.length) {
    console.log('Belum ada pemain yang tercatat.');
    return;
  }

  result.leaderboard.forEach((entry, index) => {
    console.log(
      `${index + 1}. ${entry.player_name} - ${entry.score} poin (${entry.correct_answers} benar)`
    );
  });
  console.log(`Pemenang: ${result.winner_name || 'N/A'}`);
}

async function runMaster() {
  const quizProto = loadProto('quiz.proto');
  const adminProto = loadProto('admin.proto');

  const quizClient = new quizProto.quiz.QuizService(
    SERVER_ADDRESS,
    grpc.credentials.createInsecure()
  );
  const adminClient = new adminProto.admin.AdminService(
    SERVER_ADDRESS,
    grpc.credentials.createInsecure()
  );

  const host_name = getArgValue('--host') || 'Quiz Master';
  const questions = [
    {
      question_text: 'Apa ibu kota Indonesia?',
      options: ['Surabaya', 'Jakarta', 'Bandung', 'Medan'],
      correct_answer: 'B',
      time_limit: 20
    },
    {
      question_text: 'Berapa hasil dari 7 x 8?',
      options: ['54', '56', '58', '60'],
      correct_answer: 'B',
      time_limit: 15
    },
    {
      question_text: 'Bahasa pemrograman apa yang dibuat oleh Guido van Rossum?',
      options: ['Java', 'Ruby', 'Python', 'Perl'],
      correct_answer: 'C',
      time_limit: 20
    }
  ];

  const { quiz_code, session_id, host_id } = await unary(quizClient, 'createQuiz', { host_name });
  console.log(`Quiz dibuat oleh ${host_name}`);
  console.log(`Quiz code : ${quiz_code}`);
  console.log(`Session ID: ${session_id}`);
  console.log(`Host ID   : ${host_id}`);

  const uploadResult = await uploadQuestions(adminClient, session_id, host_id, questions);
  console.log(`Upload selesai: ${uploadResult.message}`);

  console.log('\nPlayer bisa join dengan command berikut:');
  console.log(`node client/player_client.js --name "Raka" --code "${quiz_code}"`);
  console.log('\nKontrol sesi: ketik lalu ENTER');
  console.log('  s = start quiz');
  console.log('  n = next question');
  console.log('  r = lihat hasil sementara');
  console.log('  e = end quiz');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'master> '
  });

  let quizEnded = false;
  rl.prompt();

  rl.on('line', async (input) => {
    const command = String(input || '').trim().toLowerCase();
    try {
      if (command === 's') {
        const response = await unary(adminClient, 'startQuiz', { session_id, host_id });
        console.log(response.message);
      } else if (command === 'n') {
        const response = await unary(adminClient, 'nextQuestion', { session_id, host_id });
        console.log(response.message);
      } else if (command === 'r') {
        const result = await unary(quizClient, 'getQuizResult', { session_id });
        printFinalResult(result);
      } else if (command === 'e') {
        const response = await unary(adminClient, 'endQuiz', { session_id, host_id });
        console.log(response.message);
        const result = await unary(quizClient, 'getQuizResult', { session_id });
        printFinalResult(result);
        quizEnded = true;
        rl.close();
        return;
      } else {
        console.log('Perintah tidak dikenal. Gunakan s, n, r, atau e.');
      }
    } catch (err) {
      console.error(formatGrpcError(err));
    }

    if (!quizEnded) {
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log('Master client selesai.');
    process.exit(0);
  });
}

runMaster().catch((err) => {
  console.error('Master client gagal:', formatGrpcError(err));
  process.exit(1);
});
