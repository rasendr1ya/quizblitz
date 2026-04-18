const grpc = require('@grpc/grpc-js');
const { buildLeaderboard, getSessionById } = require('../../state/store');

function watchQuizEvents(call) {
  const session_id = String(call.request.session_id || '').trim();
  const player_id = String(call.request.player_id || '').trim();
  const session = getSessionById(session_id);

  if (!session) {
    call.destroy({
      code: grpc.status.NOT_FOUND,
      message: 'Session tidak ditemukan'
    });
    return;
  }

  if (player_id && !session.players[player_id]) {
    call.destroy({
      code: grpc.status.NOT_FOUND,
      message: 'Player tidak terdaftar'
    });
    return;
  }

  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    session.emitter.removeListener('quiz_event', handler);
  };

  const handler = (event) => {
    if (cleanedUp || call.cancelled) {
      cleanup();
      return;
    }

    call.write(event);

    if (event.type === 'QUIZ_END') {
      cleanup();
      call.end();
    }
  };

  session.emitter.on('quiz_event', handler);
  console.log(`Client ${player_id || 'unknown'} subscribe event stream untuk session ${session_id}`);

  call.on('cancelled', cleanup);
  call.on('close', cleanup);
  call.on('error', cleanup);
  call.on('end', cleanup);
}

function watchLeaderboard(call) {
  const session_id = String(call.request.session_id || '').trim();
  const player_id = String(call.request.player_id || '').trim();
  const session = getSessionById(session_id);

  if (!session) {
    call.destroy({
      code: grpc.status.NOT_FOUND,
      message: 'Session tidak ditemukan'
    });
    return;
  }

  if (player_id && !session.players[player_id]) {
    call.destroy({
      code: grpc.status.NOT_FOUND,
      message: 'Player tidak terdaftar'
    });
    return;
  }

  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    session.emitter.removeListener('leaderboard_update', handler);
  };

  const handler = (update) => {
    if (cleanedUp || call.cancelled) {
      cleanup();
      return;
    }
    call.write(update);
  };

  call.write({
    entries: buildLeaderboard(session).map((entry) => ({
      player_name: entry.player_name,
      score: entry.score,
      rank: entry.rank
    })),
    triggered_by: 'initial'
  });

  session.emitter.on('leaderboard_update', handler);

  call.on('cancelled', cleanup);
  call.on('close', cleanup);
  call.on('error', cleanup);
  call.on('end', cleanup);
}

module.exports = {
  watchLeaderboard,
  watchQuizEvents
};
