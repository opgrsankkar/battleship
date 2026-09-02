const test = require('node:test');
const assert = require('node:assert/strict');
const { io: createClient } = require('socket.io-client');
const { createGameServer, validateFleet, validCoordinate } = require('../server');

function validFleet() {
  const board = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let col = 0; col < 5; col++) board[0][col] = 1;
  for (let row = 1; row < 5; row++) board[row][0] = 2;
  for (let col = 2; col < 5; col++) board[2][col] = 3;
  for (let row = 4; row < 7; row++) board[row][4] = 4;
  for (let col = 7; col < 9; col++) board[8][col] = 5;
  return board;
}

function waitFor(socket, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    function handler(payload) {
      clearTimeout(timer);
      resolve(payload);
    }
    socket.once(event, handler);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, { transports: ['websocket'], forceNew: true });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

async function openServer() {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  return { game, url: `http://127.0.0.1:${game.server.address().port}` };
}

async function closeServer(game, clients) {
  clients.forEach(client => client.disconnect());
  await new Promise(resolve => game.io.close(resolve));
}

test('validateFleet accepts the standard fleet and rejects malformed boards', () => {
  const board = validFleet();
  assert.equal(validateFleet(board), true);

  const missingCell = board.map(row => [...row]);
  missingCell[0][4] = 0;
  assert.equal(validateFleet(missingCell), false);

  const bentShip = board.map(row => [...row]);
  bentShip[2][4] = 0;
  bentShip[3][3] = 3;
  assert.equal(validateFleet(bentShip), false);

  assert.equal(validateFleet([[1, 2, 3]]), false);
});

test('validCoordinate only accepts integer board coordinates', () => {
  assert.equal(validCoordinate(0), true);
  assert.equal(validCoordinate(9), true);
  assert.equal(validCoordinate(-1), false);
  assert.equal(validCoordinate(10), false);
  assert.equal(validCoordinate(2.5), false);
  assert.equal(validCoordinate('2'), false);
});

test('Quick Match pairs every two players into independent FIFO matches', { timeout: 10000 }, async () => {
  const { game, url } = await openServer();
  const clients = [];
  try {
    const [one, two, three, four] = await Promise.all([
      connect(url), connect(url), connect(url), connect(url),
    ]);
    clients.push(one, two, three, four);

    const waitingOne = waitFor(one, 'matchmaking_waiting');
    one.emit('matchmaking_join', { name: 'One' });
    assert.deepEqual(await waitingOne, { position: 1 });

    const matchOne = waitFor(one, 'match_found');
    const matchTwo = waitFor(two, 'match_found');
    two.emit('matchmaking_join', { name: 'Two' });
    const [oneResult, twoResult] = await Promise.all([matchOne, matchTwo]);
    assert.equal(oneResult.code, twoResult.code);
    assert.equal(oneResult.playerNumber, 1);
    assert.equal(twoResult.playerNumber, 2);
    assert.equal(oneResult.opponentName, 'Two');
    assert.equal(twoResult.opponentName, 'One');

    const waitingThree = waitFor(three, 'matchmaking_waiting');
    three.emit('matchmaking_join', { name: 'Three' });
    assert.deepEqual(await waitingThree, { position: 1 });

    const matchThree = waitFor(three, 'match_found');
    const matchFour = waitFor(four, 'match_found');
    four.emit('matchmaking_join', { name: 'Four' });
    const [threeResult, fourResult] = await Promise.all([matchThree, matchFour]);
    assert.equal(threeResult.code, fourResult.code);
    assert.notEqual(oneResult.code, threeResult.code);
    assert.equal(threeResult.playerNumber, 1);
    assert.equal(fourResult.playerNumber, 2);
    assert.equal(game.waitingPlayers.length, 0);
    assert.equal(game.rooms[oneResult.code].kind, 'matchmaking');
    assert.equal(game.rooms[threeResult.code].kind, 'matchmaking');

    const placementError = waitFor(one, 'placement_error');
    one.emit('ships_placed', {
      code: oneResult.code,
      board: Array.from({ length: 10 }, () => Array(10).fill(0)),
    });
    assert.equal(await placementError, 'Invalid fleet placement');

    const starts = [waitFor(one, 'game_start'), waitFor(two, 'game_start')];
    one.emit('ships_placed', { code: oneResult.code, board: validFleet() });
    two.emit('ships_placed', { code: oneResult.code, board: validFleet() });
    await Promise.all(starts);

    let leakedToOtherMatch = false;
    three.once('attack_result', () => { leakedToOtherMatch = true; });
    const attackResult = waitFor(one, 'attack_result');
    one.emit('attack', { code: oneResult.code, row: 0, col: 0 });
    assert.equal((await attackResult).hit, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(leakedToOtherMatch, false);

    const opponentLeft = waitFor(one, 'opponent_disconnected');
    two.emit('leave_game');
    await opponentLeft;
    assert.equal(game.rooms[oneResult.code], undefined);
  } finally {
    await closeServer(game, clients);
  }
});

test('Quick Match cancellation and waiting-player disconnect clean up the queue', { timeout: 5000 }, async () => {
  const { game, url } = await openServer();
  const clients = [];
  try {
    const player = await connect(url);
    clients.push(player);
    const waiting = waitFor(player, 'matchmaking_waiting');
    player.emit('matchmaking_join', { name: 'Waiting' });
    await waiting;
    assert.equal(game.waitingPlayers.length, 1);

    const duplicateWaiting = waitFor(player, 'matchmaking_waiting');
    player.emit('matchmaking_join', { name: 'Duplicate' });
    assert.deepEqual(await duplicateWaiting, { position: 1 });
    assert.equal(game.waitingPlayers.length, 1);
    assert.equal(game.waitingPlayers[0].name, 'Waiting');

    const cancelled = waitFor(player, 'matchmaking_cancelled');
    player.emit('matchmaking_cancel');
    await cancelled;
    assert.equal(game.waitingPlayers.length, 0);

    const waitingAgain = waitFor(player, 'matchmaking_waiting');
    player.emit('matchmaking_join', { name: 'Waiting' });
    await waitingAgain;
    player.disconnect();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(game.waitingPlayers.length, 0);
  } finally {
    await closeServer(game, clients);
  }
});

test('private room creation and joining remain available', { timeout: 5000 }, async () => {
  const { game, url } = await openServer();
  const clients = [];
  try {
    const host = await connect(url);
    const guest = await connect(url);
    clients.push(host, guest);

    const created = waitFor(host, 'room_created');
    host.emit('create_room', { name: 'Host' });
    const { code } = await created;

    const hostJoined = waitFor(host, 'opponent_joined');
    const guestJoined = waitFor(guest, 'room_joined');
    guest.emit('join_room', { code, name: 'Guest' });
    assert.deepEqual(await guestJoined, { code });
    await hostJoined;
    assert.equal(game.rooms[code].kind, 'private');
  } finally {
    await closeServer(game, clients);
  }
});
