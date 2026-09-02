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

test('automatic lobby assigns two seats, rejects overflow, and promotes the remaining player', { timeout: 10000 }, async () => {
  const game = createGameServer({ autoLobby: true });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const address = game.server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const clients = [];

  try {
    assert.deepEqual(await fetch(`${url}/api/config`).then(response => response.json()), { autoLobby: true });
    const player1 = await connect(url);
    clients.push(player1);
    const assignment1 = waitFor(player1, 'auto_lobby_assigned');
    player1.emit('auto_lobby_join', { name: 'One' });
    assert.deepEqual(await assignment1, { playerNumber: 1, waiting: true, code: 'AUTO' });

    const player2 = await connect(url);
    clients.push(player2);
    const player1Ready = waitFor(player1, 'opponent_joined');
    const assignment2 = waitFor(player2, 'auto_lobby_assigned');
    player2.emit('auto_lobby_join', { name: 'Two' });
    assert.deepEqual(await assignment2, { playerNumber: 2, waiting: false, code: 'AUTO' });
    await player1Ready;

    const overflow = await connect(url);
    clients.push(overflow);
    const full = waitFor(overflow, 'lobby_full');
    overflow.emit('auto_lobby_join', { name: 'Three' });
    await full;

    const placementError = waitFor(player1, 'placement_error');
    player1.emit('ships_placed', { code: 'AUTO', board: Array.from({ length: 10 }, () => Array(10).fill(0)) });
    assert.equal(await placementError, 'Invalid fleet placement');

    const left = waitFor(player1, 'opponent_disconnected');
    const reassignedAfterLeave = waitFor(player1, 'auto_lobby_assigned');
    player2.emit('auto_lobby_leave');
    await left;
    assert.deepEqual(await reassignedAfterLeave, { playerNumber: 1, waiting: true, code: 'AUTO' });

    const replacement = await connect(url);
    clients.push(replacement);
    const replacementAssignment = waitFor(replacement, 'auto_lobby_assigned');
    replacement.emit('auto_lobby_join', { name: 'Four' });
    assert.deepEqual(await replacementAssignment, { playerNumber: 2, waiting: false, code: 'AUTO' });

    const disconnected = waitFor(player1, 'opponent_disconnected');
    const reassignedAfterDisconnect = waitFor(player1, 'auto_lobby_assigned');
    replacement.disconnect();
    await disconnected;
    assert.deepEqual(await reassignedAfterDisconnect, { playerNumber: 1, waiting: true, code: 'AUTO' });
  } finally {
    clients.forEach(client => client.disconnect());
    await new Promise(resolve => game.io.close(resolve));
  }
});

test('automatic lobby protocol is disabled unless configured', { timeout: 5000 }, async () => {
  const game = createGameServer({ autoLobby: false });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const address = game.server.address();
  const client = await connect(`http://127.0.0.1:${address.port}`);
  try {
    assert.deepEqual(
      await fetch(`http://127.0.0.1:${address.port}/api/config`).then(response => response.json()),
      { autoLobby: false },
    );
    const unavailable = waitFor(client, 'auto_lobby_unavailable');
    client.emit('auto_lobby_join', { name: 'One' });
    await unavailable;
  } finally {
    client.disconnect();
    await new Promise(resolve => game.io.close(resolve));
  }
});
