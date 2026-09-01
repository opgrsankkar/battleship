const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db');

const AUTO_ROOM_CODE = 'AUTO';
const FLEET_SIZES = { 1: 5, 2: 4, 3: 3, 4: 3, 5: 2 };

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createRoom(firstPlayer = null, name = '', auto = false) {
  const room = {
    players: [],
    names: {},
    boards: {},
    hits: {},
    ready: new Set(),
    turn: null,
    auto,
  };
  if (firstPlayer) {
    room.players.push(firstPlayer);
    room.names[firstPlayer] = db.cleanName(name);
  }
  return room;
}

function checkSunk(board, shipId) {
  return !board.some(row => row.some(cell => cell === shipId));
}

function checkWin(board) {
  return !board.some(row => row.some(cell => Number.isInteger(cell) && cell > 0));
}

function validCoordinate(value) {
  return Number.isInteger(value) && value >= 0 && value < 10;
}

function validateFleet(board) {
  if (!Array.isArray(board) || board.length !== 10
    || board.some(row => !Array.isArray(row) || row.length !== 10)) return false;
  if (board.some(row => row.some(cell => !Number.isInteger(cell) || cell < 0 || cell > 5))) return false;

  for (const [shipIdText, expectedSize] of Object.entries(FLEET_SIZES)) {
    const shipId = Number(shipIdText);
    const cells = [];
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        if (board[row][col] === shipId) cells.push([row, col]);
      }
    }
    if (cells.length !== expectedSize) return false;
    const sameRow = cells.every(([row]) => row === cells[0][0]);
    const sameCol = cells.every(([, col]) => col === cells[0][1]);
    if (!sameRow && !sameCol) return false;
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let index = 1; index < cells.length; index++) {
      const rowStep = cells[index][0] - cells[index - 1][0];
      const colStep = cells[index][1] - cells[index - 1][1];
      if ((sameRow && (rowStep !== 0 || colStep !== 1))
        || (sameCol && (rowStep !== 1 || colStep !== 0))) return false;
    }
  }
  return true;
}

function resetMatch(room) {
  room.boards = {};
  room.hits = {};
  room.ready = new Set();
  room.turn = null;
}

function createGameServer(options = {}) {
  const autoLobby = options.autoLobby ?? envFlag(process.env.AUTO_LOBBY);
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const rooms = {};

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/api/config', (_req, res) => {
    res.json({ autoLobby });
  });
  app.get('/api/leaderboard', async (_req, res) => {
    const players = await db.getLeaderboard(20);
    res.json({ game: db.GAME, players });
  });

  function leaveAutoLobby(socket) {
    const room = rooms[AUTO_ROOM_CODE];
    if (!room?.players.includes(socket.id)) return false;
    room.players = room.players.filter(id => id !== socket.id);
    delete room.names[socket.id];
    resetMatch(room);
    socket.leave(AUTO_ROOM_CODE);
    socket.data.roomCode = null;
    io.to(AUTO_ROOM_CODE).emit('opponent_disconnected');
    if (!room.players.length) {
      delete rooms[AUTO_ROOM_CODE];
    } else {
      io.to(room.players[0]).emit('auto_lobby_assigned', {
        playerNumber: 1,
        waiting: true,
        code: AUTO_ROOM_CODE,
      });
    }
    return true;
  }

  io.on('connection', (socket) => {
    socket.on('auto_lobby_join', (payload = {}) => {
      if (!autoLobby) return socket.emit('auto_lobby_unavailable');
      const existing = rooms[AUTO_ROOM_CODE];
      if (existing?.players.includes(socket.id)) {
        return socket.emit('auto_lobby_assigned', {
          playerNumber: existing.players.indexOf(socket.id) + 1,
          waiting: existing.players.length < 2,
          code: AUTO_ROOM_CODE,
        });
      }
      const room = existing || (rooms[AUTO_ROOM_CODE] = createRoom(null, '', true));
      if (room.players.length >= 2) return socket.emit('lobby_full');

      room.players.push(socket.id);
      room.names[socket.id] = db.cleanName(payload.name);
      socket.data.roomCode = AUTO_ROOM_CODE;
      socket.join(AUTO_ROOM_CODE);
      socket.emit('auto_lobby_assigned', {
        playerNumber: room.players.length,
        waiting: room.players.length < 2,
        code: AUTO_ROOM_CODE,
      });
      if (room.players.length === 2) io.to(AUTO_ROOM_CODE).emit('opponent_joined');
    });

    socket.on('auto_lobby_leave', () => {
      leaveAutoLobby(socket);
    });

    socket.on('create_room', (payload = {}) => {
      let code = makeCode();
      while (rooms[code]) code = makeCode();
      rooms[code] = createRoom(socket.id, payload.name);
      socket.data.roomCode = code;
      socket.join(code);
      socket.emit('room_created', { code });
    });

    socket.on('join_room', ({ code, name } = {}) => {
      const normalized = typeof code === 'string' ? code.toUpperCase() : '';
      const room = rooms[normalized];
      if (!room || room.auto) return socket.emit('join_error', 'Room not found');
      if (room.players.length >= 2) return socket.emit('join_error', 'Room is full');
      room.players.push(socket.id);
      room.names[socket.id] = db.cleanName(name);
      socket.data.roomCode = normalized;
      socket.join(normalized);
      socket.emit('room_joined', { code: normalized });
      io.to(normalized).emit('opponent_joined');
    });

    socket.on('ships_placed', ({ code, board } = {}) => {
      const room = rooms[code];
      if (!room || !room.players.includes(socket.id)) return;
      if (!validateFleet(board)) return socket.emit('placement_error', 'Invalid fleet placement');
      room.boards[socket.id] = board.map(row => [...row]);
      room.hits[socket.id] = Array.from({ length: 10 }, () => Array(10).fill(false));
      room.ready.add(socket.id);
      if (room.ready.size === 2) {
        room.turn = room.players[0];
        io.to(code).emit('game_start', { firstTurn: room.turn });
      } else {
        socket.to(code).emit('opponent_ready');
        socket.emit('waiting_for_opponent');
      }
    });

    socket.on('attack', ({ code, row, col } = {}) => {
      const room = rooms[code];
      if (!room || room.turn !== socket.id || !validCoordinate(row) || !validCoordinate(col)) return;
      const opponentId = room.players.find(id => id !== socket.id);
      const board = room.boards[opponentId];
      if (!opponentId || !board || room.hits[opponentId]?.[row]?.[col]) return;

      room.hits[opponentId][row][col] = true;
      const cellValue = board[row][col];
      const hit = Number.isInteger(cellValue) && cellValue > 0;
      let sunkShip = null;
      if (hit) {
        board[row][col] = 0;
        if (checkSunk(board, cellValue)) sunkShip = cellValue;
      }

      const won = hit && checkWin(board);
      const nextTurn = won ? null : (hit ? socket.id : opponentId);
      if (!won) room.turn = nextTurn;

      io.to(code).emit('attack_result', {
        attacker: socket.id,
        row,
        col,
        hit,
        sunkShip,
        won,
        nextTurn,
      });

      if (won) {
        db.recordMatch(room.names[socket.id], room.names[opponentId], room.names[socket.id]);
        if (room.auto) resetMatch(room);
        else delete rooms[code];
      }
    });

    socket.on('disconnect', () => {
      const code = socket.data.roomCode;
      const room = rooms[code];
      if (!room || !room.players.includes(socket.id)) return;
      if (!room.auto) {
        io.to(code).emit('opponent_disconnected');
        delete rooms[code];
        return;
      }
      leaveAutoLobby(socket);
    });
  });

  return { app, server, io, rooms, autoLobby };
}

if (require.main === module) {
  const { server } = createGameServer();
  const port = process.env.PORT || 3025;
  server.listen(port, () => console.log(`Battleship running on port ${port}`));
}

module.exports = {
  AUTO_ROOM_CODE,
  createGameServer,
  validateFleet,
  validCoordinate,
};
