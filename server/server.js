const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { store, clearQuestionTimer } = require('../state/store');

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

const quizProto = loadProto('quiz.proto');
const streamProto = loadProto('stream.proto');
const adminProto = loadProto('admin.proto');

const server = new grpc.Server();

server.addService(quizProto.quiz.QuizService.service, require('./services/quizService'));
server.addService(streamProto.stream.StreamService.service, require('./services/streamService'));
server.addService(adminProto.admin.AdminService.service, require('./services/adminService'));

const PORT = process.env.PORT || '0.0.0.0:50051';

server.bindAsync(PORT, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error('Gagal menjalankan gRPC server:', err);
    return;
  }

  console.log(`gRPC Server running on port ${port}`);
});

function shutdown() {
  Object.values(store.sessions).forEach((session) => clearQuestionTimer(session));
  server.tryShutdown(() => {
    console.log('gRPC Server shutdown selesai');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
