const socket = io();

// ── Constants ────────────────────────────────────────────────────────────────
const SHIPS = [
  { id: 1, name: 'Carrier',    size: 5 },
  { id: 2, name: 'Battleship', size: 4 },
  { id: 3, name: 'Cruiser',    size: 3 },
  { id: 4, name: 'Submarine',  size: 3 },
  { id: 5, name: 'Destroyer',  size: 2 },
];
const COLS = 'ABCDEFGHIJ';
const DOUBLE_TAP_MS = 350;
let lastShipTap = { shipId: null, at: 0 };
let lastPlacedShipTap = { shipId: null, at: 0 };
let lastPlacementPointerType = 'mouse';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  mode: null,          // 'single' | 'multi'
  difficulty: 'medium',
  roomCode: null,
  autoLobby: false,
  playerNumber: null,
  myBoard: null,       // 10x10, cell = 0|shipId
  oppHits: null,       // 10x10 bool — cells I've attacked on opp board
  myHits: null,        // 10x10 bool — cells opp has attacked on my board
  myTurn: false,
  shipCounts: { my: {}, opp: {} },
  gameOver: false,

  // placement
  placedShips: new Set(),
  shipPlacements: {},
  selectedShip: null,
  horizontal: true,
  hoverCell: null,
  dragPlacement: null,

  // AI
  aiBoard: null,
  aiHits: null,
  aiQueue: [],
  aiLastHit: null,
  aiDirection: null,
  aiShipCounts: {},
  aiProbGrid: null,
};

// ── Screens ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'screen-menu') history.replaceState(null, '', '/');
}

// ── URL room sharing ──────────────────────────────────────────────────────────
function setRoomInUrl(code) {
  history.replaceState(null, '', `/?room=${code}`);
}

function copyLink() {
  navigator.clipboard.writeText(window.location.href);
  const btn = event.target;
  btn.textContent = T('copied');
  setTimeout(() => btn.textContent = T('copyLink'), 1500);
}

window.addEventListener('DOMContentLoaded', () => {
  // Prefill nickname field from storage.
  const nameInput = document.getElementById('name-input');
  if (nameInput) nameInput.value = window.PlayerName.get();

  loadLeaderboard();

  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) {
    showScreen('screen-mp-menu');
    document.getElementById('room-input').value = room.toUpperCase();
    document.getElementById('mp-status').textContent = T('joiningRoom', { code: room.toUpperCase() });
    socket.emit('join_room', { code: room.toUpperCase(), name: currentName() });
  } else {
    loadClientConfig();
  }
});

// Read the nickname field (or storage), persist it, and return it.
function currentName() {
  const el = document.getElementById('name-input');
  const n = window.PlayerName.set(el ? el.value : window.PlayerName.get());
  return n;
}

async function loadLeaderboard() {
  const body = document.getElementById('lb-body');
  if (!body) return;
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const players = (data && data.players) || [];
    if (!players.length) { body.innerHTML = '<tr><td colspan="5">No games played yet — be the first!</td></tr>'; return; }
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const me = window.PlayerName.get();
    body.innerHTML = players.map((p, i) =>
      `<tr class="${me && p.player === me ? 'lb-me' : ''}"><td>${i + 1}</td><td>${esc(p.player)}</td><td>${p.wins}</td><td>${p.losses}</td><td>${p.draws}</td></tr>`
    ).join('');
  } catch { body.innerHTML = '<tr><td colspan="5">Leaderboard unavailable.</td></tr>'; }
}

async function loadClientConfig() {
  try {
    const response = await fetch('/api/config');
    const config = await response.json();
    if (config.autoLobby) retryAutoLobby();
  } catch {
    // Static deployments and older servers keep the normal menu.
  }
}

function retryAutoLobby() {
  state.autoLobby = true;
  state.mode = 'multi';
  state.roomCode = 'AUTO';
  document.getElementById('auto-player-badge').textContent = T('autoConnecting');
  document.getElementById('auto-lobby-status').textContent = T('autoConnecting');
  document.getElementById('auto-overflow-actions').classList.add('hidden');
  showScreen('screen-auto-lobby');
  socket.emit('auto_lobby_join', { name: currentName() });
}

function startOverflowAI() {
  state.autoLobby = false;
  state.playerNumber = null;
  startSinglePlayer();
}

// ── Menu actions ──────────────────────────────────────────────────────────────
function startSinglePlayer() {
  state.mode = 'single';
  showScreen('screen-difficulty');
}

function setDifficulty(d) {
  state.difficulty = d;
  initPlacement();
  showScreen('screen-placement');
}

function createRoom() {
  socket.emit('create_room', { name: currentName() });
}

function joinRoom() {
  const code = document.getElementById('room-input').value.trim().toUpperCase();
  if (!code) return;
  socket.emit('join_room', { code, name: currentName() });
}

function copyCode() {
  navigator.clipboard.writeText(state.roomCode);
  const btn = event.target;
  btn.textContent = T('copied');
  setTimeout(() => btn.textContent = T('copyCode'), 1500);
}

// ── Socket events ─────────────────────────────────────────────────────────────
socket.on('auto_lobby_assigned', ({ playerNumber, waiting, code }) => {
  state.autoLobby = true;
  state.mode = 'multi';
  state.roomCode = code;
  state.playerNumber = playerNumber;
  document.getElementById('auto-player-badge').textContent = T('autoAssigned', { player: playerNumber });
  document.getElementById('auto-lobby-status').textContent = waiting ? T('autoWaiting') : T('oppReady');
  document.getElementById('auto-overflow-actions').classList.add('hidden');
  showScreen('screen-auto-lobby');
});

socket.on('lobby_full', () => {
  state.autoLobby = false;
  state.mode = null;
  state.roomCode = null;
  state.playerNumber = null;
  document.getElementById('auto-player-badge').textContent = T('autoFullBadge');
  document.getElementById('auto-lobby-status').textContent = T('autoFull');
  document.getElementById('auto-overflow-actions').classList.remove('hidden');
  showScreen('screen-auto-lobby');
});

socket.on('auto_lobby_unavailable', () => {
  state.autoLobby = false;
  showScreen('screen-menu');
});

socket.on('room_created', ({ code }) => {
  state.autoLobby = false;
  state.roomCode = code;
  state.mode = 'multi';
  document.getElementById('room-code-text').textContent = code;
  document.getElementById('room-code-display').classList.remove('hidden');
  document.getElementById('mp-status').textContent = T('waitingJoin');
  setRoomInUrl(code);
});

socket.on('join_error', (msg) => {
  document.getElementById('mp-status').textContent = msg;
});

socket.on('room_joined', ({ code }) => {
  state.autoLobby = false;
  state.roomCode = code;
  state.mode = 'multi';
  initPlacement();
  showScreen('screen-placement');
});

socket.on('opponent_joined', () => {
  initPlacement();
  showScreen('screen-placement');
});

socket.on('opponent_ready', () => {
  document.getElementById('mp-status') && (document.getElementById('mp-status').textContent = T('oppReady'));
});

socket.on('waiting_for_opponent', () => {
  showScreen('screen-waiting');
});

socket.on('game_start', ({ firstTurn }) => {
  state.myTurn = (firstTurn === socket.id || firstTurn === 'ai');
  initGame();
  showScreen('screen-game');
});

socket.on('attack_result', ({ attacker, row, col, hit, sunkShip, won, nextTurn }) => {
  const iMadeAttack = (attacker === socket.id);
  if (iMadeAttack) {
    state.oppHits[row][col] = hit ? 'hit' : 'miss';
    if (sunkShip) markSunkOnOppBoard(sunkShip);
    renderOppBoard();
    logEntry(hit ? T('youHit', { cell: COLS[col] + (row + 1) }) : T('youMissed', { cell: COLS[col] + (row + 1) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) { logEntry(T('youSunkTheir', { ship: shipName(sunkShip) }), 'sunk'); updateShipStatus('opp', sunkShip); }
  } else {
    state.myHits[row][col] = hit ? 'hit' : 'miss';
    renderMyBoard();
    logEntry(hit ? T('oppHit', { cell: COLS[col] + (row + 1) }) : T('oppMissed', { cell: COLS[col] + (row + 1) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) { logEntry(T('theySunkYour', { ship: shipName(sunkShip) }), 'sunk'); updateShipStatus('my', sunkShip); }
  }
  if (won) {
    showResult(iMadeAttack);
  } else {
    state.myTurn = (nextTurn === socket.id);
    updateTurnDisplay();
  }
});

socket.on('opponent_disconnected', () => {
  if (state.autoLobby) {
    document.getElementById('auto-lobby-status').textContent = T('autoOpponentLeft');
    showScreen('screen-auto-lobby');
  } else {
    if (!state.gameOver) alert(T('oppDisconnected'));
    showScreen('screen-menu');
  }
});

// ── Placement ─────────────────────────────────────────────────────────────────
function initPlacement() {
  state.myBoard = Array.from({ length: 10 }, () => Array(10).fill(0));
  state.placedShips = new Set();
  state.shipPlacements = {};
  state.selectedShip = null;
  state.horizontal = true;
  state.dragPlacement = null;
  lastShipTap = { shipId: null, at: 0 };
  lastPlacedShipTap = { shipId: null, at: 0 };

  buildShipList();
  buildBoard('place-board', onPlaceCellClick, onPlaceCellHover, onPlaceBoardLeave);
  buildLabels('col-labels-place', 'row-labels-place');
  document.getElementById('ready-btn').disabled = true;

  document.addEventListener('keydown', handleKey);
}

function buildShipList() {
  const list = document.getElementById('ship-list');
  list.innerHTML = '';
  SHIPS.forEach(ship => {
    const el = document.createElement('div');
    el.className = 'ship-item';
    el.id = `ship-item-${ship.id}`;
    el.onclick = () => selectShip(ship.id);
    el.addEventListener('pointerdown', e => beginShipListDrag(e, ship.id));
    el.addEventListener('pointerup', e => handleShipPointerUp(e, ship.id));
    el.innerHTML = `
      <div class="ship-blocks">${'<div class="ship-block"></div>'.repeat(ship.size)}</div>
      <div><div class="ship-name">${ship.name}</div><div class="ship-len">${ship.size} cells</div></div>`;
    list.appendChild(el);
  });
}

function selectShip(id) {
  if (state.placedShips.has(id)) return;
  state.selectedShip = SHIPS.find(s => s.id === id);
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById(`ship-item-${id}`);
  if (el) el.classList.add('selected');
  updateOrientationIndicator();
  clearPreview();
}

function rotateShip() {
  const nextHorizontal = !state.horizontal;
  const placed = state.selectedShip && state.shipPlacements[state.selectedShip.id];
  if (placed && !state.dragPlacement) {
    const preferred = { ...placed, horizontal: nextHorizontal };
    const nearest = Placement.findNearestPlacement(state.myBoard, state.selectedShip.id, preferred);
    if (!nearest) return;
    Placement.placeShip(state.myBoard, state.selectedShip.id, nearest);
    state.shipPlacements[state.selectedShip.id] = nearest;
    state.horizontal = nextHorizontal;
    renderPlacementBoard();
  } else {
    state.horizontal = nextHorizontal;
    if (state.dragPlacement) state.dragPlacement.rotationChanged = true;
  }
  updateOrientationIndicator();
  if (state.hoverCell) showPreview(...state.hoverCell);
}

function handleKey(e) {
  if ((e.key === 'r' || e.key === 'R') && !e.repeat) {
    e.preventDefault();
    rotateShip();
  }
}

function handleShipPointerUp(e, shipId) {
  if (e.pointerType !== 'touch') return;

  const now = performance.now();
  const isDoubleTap = lastShipTap.shipId === shipId && now - lastShipTap.at <= DOUBLE_TAP_MS;
  lastShipTap = isDoubleTap ? { shipId: null, at: 0 } : { shipId, at: now };
  if (!isDoubleTap) return;

  e.preventDefault();
  selectShip(shipId);
  if (state.selectedShip?.id === shipId) rotateShip();
}

function updateOrientationIndicator() {
  document.querySelectorAll('.ship-item').forEach(el => el.removeAttribute('data-orientation'));
  if (!state.selectedShip) return;
  const selected = document.getElementById(`ship-item-${state.selectedShip.id}`);
  if (selected) selected.dataset.orientation = state.horizontal ? '↔' : '↕';
}

function beginShipListDrag(e, shipId) {
  if (e.button !== 0 || state.placedShips.has(shipId)) return;
  selectShip(shipId);
  if (!state.selectedShip) return;
  state.dragPlacement = {
    ship: state.selectedShip,
    original: null,
    grabOffset: 0,
    pointerId: e.pointerId,
  };
  document.body.classList.add('placing-drag');
}

function beginPlacedShipDrag(e, r, c) {
  if (e.button !== 0) return;
  const shipId = state.myBoard[r][c];
  if (!shipId) return;
  const ship = SHIPS.find(candidate => candidate.id === shipId);
  const original = state.shipPlacements[shipId] || Placement.findShip(state.myBoard, shipId);
  if (!ship || !original) return;

  state.selectedShip = ship;
  state.horizontal = original.horizontal;
  state.dragPlacement = {
    ship,
    original: { row: original.row, col: original.col, size: ship.size, horizontal: original.horizontal },
    grabOffset: original.horizontal ? c - original.col : r - original.row,
    pointerId: e.pointerId,
    rotationChanged: false,
  };
  Placement.clearShip(state.myBoard, shipId);
  delete state.shipPlacements[shipId];
  state.placedShips.delete(shipId);
  document.getElementById('ready-btn').disabled = true;
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('selected'));
  const item = document.getElementById(`ship-item-${shipId}`);
  item.classList.remove('placed');
  item.classList.add('selected');
  updateOrientationIndicator();
  renderPlacementBoard();
  document.body.classList.add('placing-drag');
  e.preventDefault();
}

function placementAtPointer(e) {
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('#place-board .cell');
  if (!target || !state.dragPlacement) return null;
  const row = Number(target.dataset.r);
  const col = Number(target.dataset.c);
  const { ship, grabOffset } = state.dragPlacement;
  return {
    row: state.horizontal ? row : row - grabOffset,
    col: state.horizontal ? col - grabOffset : col,
    size: ship.size,
    horizontal: state.horizontal,
  };
}

function handlePlacementPointerMove(e) {
  if (!state.dragPlacement || e.pointerId !== state.dragPlacement.pointerId) return;
  const placement = placementAtPointer(e);
  clearPreview();
  if (!placement) {
    state.hoverCell = null;
    return;
  }
  state.hoverCell = [placement.row, placement.col];
  showPreview(placement.row, placement.col);
  e.preventDefault();
}

function commitShipPlacement(ship, placement, selectNext = true) {
  if (!Placement.placeShip(state.myBoard, ship.id, placement)) return false;
  state.shipPlacements[ship.id] = { ...placement };
  state.placedShips.add(ship.id);
  renderPlacementBoard();
  const item = document.getElementById(`ship-item-${ship.id}`);
  item.classList.add('placed');
  item.classList.remove('selected');
  item.removeAttribute('data-orientation');
  state.selectedShip = null;

  const next = selectNext && SHIPS.find(candidate => !state.placedShips.has(candidate.id));
  if (next) selectShip(next.id);
  document.getElementById('ready-btn').disabled = state.placedShips.size !== SHIPS.length;
  return true;
}

function finishPlacementDrag(e, cancelled = false) {
  const drag = state.dragPlacement;
  if (!drag || e.pointerId !== drag.pointerId) return;
  let placement = cancelled ? null : placementAtPointer(e);
  if (placement && drag.rotationChanged && !Placement.canPlace(state.myBoard, drag.ship.id, placement)) {
    placement = Placement.findNearestPlacement(state.myBoard, drag.ship.id, placement);
  }
  const committed = placement && commitShipPlacement(drag.ship, placement, !drag.original);

  if (!committed && drag.original) commitShipPlacement(drag.ship, drag.original, false);
  if (!committed && !drag.original) {
    state.selectedShip = drag.ship;
    document.getElementById(`ship-item-${drag.ship.id}`).classList.add('selected');
    updateOrientationIndicator();
  }

  state.dragPlacement = null;
  state.hoverCell = null;
  clearPreview();
  document.body.classList.remove('placing-drag');
}

document.addEventListener('pointermove', handlePlacementPointerMove, { passive: false });
document.addEventListener('pointerup', e => finishPlacementDrag(e));
document.addEventListener('pointercancel', e => finishPlacementDrag(e, true));

function selectPlacedShip(shipId) {
  const ship = SHIPS.find(candidate => candidate.id === shipId);
  const placement = state.shipPlacements[shipId];
  if (!ship || !placement) return;
  state.selectedShip = ship;
  state.horizontal = placement.horizontal;
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('selected'));
  document.getElementById(`ship-item-${shipId}`).classList.add('selected');
  updateOrientationIndicator();
  renderPlacementBoard();
}

function onPlaceCellHover(r, c) {
  state.hoverCell = [r, c];
  clearPreview();
  if (state.selectedShip) showPreview(r, c);
}

function onPlaceBoardLeave() {
  state.hoverCell = null;
  clearPreview();
}

function showPreview(r, c) {
  const ship = state.selectedShip;
  if (!ship) return;
  const cells = getShipCells(r, c, ship.size, state.horizontal);
  const valid = cells && cells.every(([rr, cc]) => state.myBoard[rr][cc] === 0);
  if (!cells) return;
  cells.forEach(([rr, cc]) => {
    const cell = getCell('place-board', rr, cc);
    cell.classList.add(valid ? 'ship-preview' : 'ship-invalid');
  });
}

function clearPreview() {
  document.querySelectorAll('#place-board .ship-preview, #place-board .ship-invalid')
    .forEach(el => { el.classList.remove('ship-preview', 'ship-invalid'); });
}

function onPlaceCellClick(r, c) {
  const placedShipId = state.myBoard[r][c];
  if (placedShipId) {
    selectPlacedShip(placedShipId);
    if (lastPlacementPointerType === 'touch') {
      const now = performance.now();
      const isDoubleTap = lastPlacedShipTap.shipId === placedShipId
        && now - lastPlacedShipTap.at <= DOUBLE_TAP_MS;
      lastPlacedShipTap = isDoubleTap ? { shipId: null, at: 0 } : { shipId: placedShipId, at: now };
      if (isDoubleTap) rotateShip();
    }
    return;
  }
  if (!state.selectedShip) return;
  const ship = state.selectedShip;
  const movingPlacedShip = state.placedShips.has(ship.id);
  const placement = { row: r, col: c, size: ship.size, horizontal: state.horizontal };
  if (!commitShipPlacement(ship, placement, !movingPlacedShip)) return;
  clearPreview();
}

function getShipCells(r, c, size, horiz) {
  return Placement.cellsFor(r, c, size, horiz);
}

function randomPlacement() {
  state.myBoard = Array.from({ length: 10 }, () => Array(10).fill(0));
  state.placedShips = new Set();
  state.shipPlacements = {};
  SHIPS.forEach(ship => {
    let placed = false;
    while (!placed) {
      const horiz = Math.random() < 0.5;
      const r = Math.floor(Math.random() * 10);
      const c = Math.floor(Math.random() * 10);
      const placement = { row: r, col: c, size: ship.size, horizontal: horiz };
      if (Placement.placeShip(state.myBoard, ship.id, placement)) {
        state.shipPlacements[ship.id] = placement;
        state.placedShips.add(ship.id);
        placed = true;
      }
    }
    document.getElementById(`ship-item-${ship.id}`).classList.add('placed');
  });
  renderPlacementBoard();
  state.selectedShip = null;
  document.getElementById('ready-btn').disabled = false;
}

function renderPlacementBoard() {
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++) {
      const cell = getCell('place-board', r, c);
      cell.className = 'cell';
      if (state.myBoard[r][c] > 0) {
        cell.classList.add('ship');
        if (state.selectedShip?.id === state.myBoard[r][c]) cell.classList.add('ship-selected');
      }
    }
}

function confirmPlacement() {
  document.removeEventListener('keydown', handleKey);
  if (state.mode === 'single') {
    setupAI();
    state.myTurn = true;
    initGame();
    showScreen('screen-game');
  } else {
    socket.emit('ships_placed', { code: state.roomCode, board: state.myBoard });
  }
}

// ── AI Setup ──────────────────────────────────────────────────────────────────
function setupAI() {
  state.aiBoard = Array.from({ length: 10 }, () => Array(10).fill(0));
  state.aiHits = Array.from({ length: 10 }, () => Array(10).fill(false));
  state.aiQueue = [];
  state.aiLastHit = null;
  state.aiDirection = null;
  state.aiShipCounts = {};

  SHIPS.forEach(ship => {
    let placed = false;
    while (!placed) {
      const horiz = Math.random() < 0.5;
      const r = Math.floor(Math.random() * 10);
      const c = Math.floor(Math.random() * 10);
      const cells = getShipCells(r, c, ship.size, horiz);
      if (cells && cells.every(([rr, cc]) => state.aiBoard[rr][cc] === 0)) {
        cells.forEach(([rr, cc]) => { state.aiBoard[rr][cc] = ship.id; });
        placed = true;
      }
    }
    state.aiShipCounts[ship.id] = ship.size;
  });
}

function aiAttack() {
  setTimeout(() => {
    const [r, c] = chooseAIMove();
    state.aiHits[r][c] = true;

    const cellVal = state.myBoard[r][c];
    const hit = cellVal > 0;
    let sunkShip = null;

    if (hit) {
      state.myBoard[r][c] = 0;
      if (!state.myBoard.some(row => row.some(v => v === cellVal))) {
        sunkShip = cellVal;
        updateShipStatus('my', sunkShip);
        resetAIHuntChain();
      } else {
        enqueueAdjacentForAI(r, c);
      }
    }

    state.myHits[r][c] = hit ? 'hit' : 'miss';
    renderMyBoard();
    logEntry(hit ? T('oppHit', { cell: COLS[c] + (r + 1) }) : T('oppMissed', { cell: COLS[c] + (r + 1) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) logEntry(T('theySunkYour', { ship: shipName(sunkShip) }), 'sunk');

    const won = !state.myBoard.some(row => row.some(v => v > 0));
    if (won) { showResult(false); return; }

    state.myTurn = true;
    updateTurnDisplay();
  }, 700 + Math.random() * 600);
}

function chooseAIMove() {
  const diff = state.difficulty;
  if (diff === 'easy') return randomUnattacked();
  if (diff === 'medium') return huntTarget();
  return probabilistic();
}

function randomUnattacked() {
  const avail = [];
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (!state.aiHits[r][c]) avail.push([r, c]);
  return avail[Math.floor(Math.random() * avail.length)];
}

function huntTarget() {
  while (state.aiQueue.length) {
    const [r, c] = state.aiQueue.shift();
    if (!state.aiHits[r][c]) return [r, c];
  }
  return randomUnattacked();
}

function enqueueAdjacentForAI(r, c) {
  [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].forEach(([rr, cc]) => {
    if (rr >= 0 && rr < 10 && cc >= 0 && cc < 10 && !state.aiHits[rr][cc])
      if (!state.aiQueue.some(([a,b]) => a===rr && b===cc))
        state.aiQueue.push([rr, cc]);
  });
}

function resetAIHuntChain() { state.aiQueue = []; }

function probabilistic() {
  const grid = Array.from({ length: 10 }, () => Array(10).fill(0));
  const remaining = SHIPS.filter(s => state.myBoard.some(row => row.some(v => v === s.id)));

  remaining.forEach(ship => {
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        ['h','v'].forEach(dir => {
          const cells = getShipCells(r, c, ship.size, dir === 'h');
          if (cells && cells.every(([rr, cc]) => !state.aiHits[rr][cc])) {
            cells.forEach(([rr, cc]) => grid[rr][cc]++);
          }
        });
      }
    }
  });

  let best = -1, bestCells = [];
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (!state.aiHits[r][c]) {
        if (grid[r][c] > best) { best = grid[r][c]; bestCells = [[r,c]]; }
        else if (grid[r][c] === best) bestCells.push([r,c]);
      }
  return bestCells[Math.floor(Math.random() * bestCells.length)] || randomUnattacked();
}

// ── Game Init ─────────────────────────────────────────────────────────────────
function initGame() {
  state.oppHits = Array.from({ length: 10 }, () => Array(10).fill(false));
  state.myHits = Array.from({ length: 10 }, () => Array(10).fill(false));
  state.gameOver = false;

  buildBoard('my-board', null, null, null, true);
  buildBoard('opp-board', onOppCellClick, null, null, false);
  buildLabels('col-labels-my', 'row-labels-my');
  buildLabels('col-labels-opp', 'row-labels-opp');

  // Init ship status pips
  initShipStatus('my');
  initShipStatus('opp');

  renderMyBoard();
  renderOppBoard();
  updateTurnDisplay();
  document.getElementById('game-log').innerHTML = '';
}

function initShipStatus(who) {
  const el = document.getElementById(`${who}-ships`);
  el.innerHTML = '';
  SHIPS.forEach(s => {
    const pip = document.createElement('div');
    pip.className = 'ship-pip';
    pip.id = `pip-${who}-${s.id}`;
    el.appendChild(pip);
  });
}

function updateShipStatus(who, shipId) {
  const pip = document.getElementById(`pip-${who}-${shipId}`);
  if (pip) pip.classList.add('sunk');
}

function updateTurnDisplay() {
  const el = document.getElementById('turn-indicator');
  el.textContent = state.myTurn ? T('yourTurn') : T('oppTurn');
  el.classList.toggle('opponent-turn', !state.myTurn);

  document.querySelectorAll('#opp-board .cell').forEach(cell => {
    const r = parseInt(cell.dataset.r), c = parseInt(cell.dataset.c);
    const alreadyHit = state.oppHits[r][c] !== false;
    if (!alreadyHit && state.myTurn && !state.gameOver) {
      cell.classList.add('attackable');
      cell.classList.remove('no-hover');
    } else {
      cell.classList.remove('attackable');
      cell.classList.add('no-hover');
    }
  });
}

function onOppCellClick(r, c) {
  if (!state.myTurn || state.gameOver) return;
  if (state.oppHits[r][c] !== false) return;

  if (state.mode === 'single') {
    state.myTurn = false;
    updateTurnDisplay();

    const board = state.aiBoard;
    const cellVal = board[r][c];
    const hit = cellVal > 0;
    let sunkShip = null;

    if (hit) {
      board[r][c] = 0;
      if (!board.some(row => row.some(v => v === cellVal))) sunkShip = cellVal;
    }
    state.oppHits[r][c] = hit ? 'hit' : 'miss';
    if (sunkShip) updateShipStatus('opp', sunkShip);
    renderOppBoard();
    logEntry(hit ? T('youHit', { cell: COLS[c] + (r + 1) }) : T('youMissed', { cell: COLS[c] + (r + 1) }), hit ? (sunkShip ? 'sunk' : 'hit') : 'miss');
    if (sunkShip) logEntry(T('youSunkTheir', { ship: shipName(sunkShip) }), 'sunk');

    const won = !board.some(row => row.some(v => v > 0));
    if (won) { showResult(true); return; }

    aiAttack();
  } else {
    state.myTurn = false;
    updateTurnDisplay();
    socket.emit('attack', { code: state.roomCode, row: r, col: c });
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderMyBoard() {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = getCell('my-board', r, c);
      cell.className = 'cell no-hover';
      const hit = state.myHits[r][c];
      const hasShip = state.myBoard[r][c] > 0;
      if (hit === 'hit') cell.classList.add(hasShip || true ? 'hit' : 'hit');
      else if (hit === 'miss') cell.classList.add('miss');
      else if (hasShip) cell.classList.add('ship');
    }
  }
}

function renderOppBoard() {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = getCell('opp-board', r, c);
      const hit = state.oppHits[r][c];
      const cls = ['cell'];
      if (hit === 'hit') cls.push('hit');
      else if (hit === 'sunk') cls.push('sunk');
      else if (hit === 'miss') cls.push('miss');
      cell.className = cls.join(' ');
      if (!hit && state.myTurn && !state.gameOver) cell.classList.add('attackable');
      else cell.classList.add('no-hover');
    }
  }
}

function markSunkOnOppBoard(shipId) {
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      if (state.oppHits[r][c] === 'hit') {
        // Mark all hit cells as potentially sunk (simple visual)
      }
  // For visual, we'd need to track which cells belong to which sunk ship.
  // This is stored server-side; just update the pip.
}

// ── Board Builder ─────────────────────────────────────────────────────────────
function buildBoard(id, onClick, onHover, onLeave, noClick) {
  const board = document.getElementById(id);
  board.innerHTML = '';
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      if (onClick) cell.addEventListener('click', e => onClick(r, c, e));
      if (id === 'place-board') cell.addEventListener('pointerdown', e => beginPlacedShipDrag(e, r, c));
      if (id === 'place-board') cell.addEventListener('pointerup', e => { lastPlacementPointerType = e.pointerType; });
      if (onHover) cell.addEventListener('mouseenter', () => onHover(r, c));
      if (onLeave) {
        const wrap = document.getElementById(id);
        wrap.addEventListener('mouseleave', onLeave);
      }
      board.appendChild(cell);
    }
  }
}

function buildLabels(colId, rowId) {
  const cols = document.getElementById(colId);
  cols.innerHTML = '';
  for (let c = 0; c < 10; c++) {
    const span = document.createElement('span');
    span.textContent = COLS[c];
    cols.appendChild(span);
  }
  const rows = document.getElementById(rowId);
  rows.innerHTML = '';
  for (let r = 0; r < 10; r++) {
    const span = document.createElement('span');
    span.textContent = r + 1;
    rows.appendChild(span);
  }
}

function getCell(boardId, r, c) {
  return document.querySelector(`#${boardId} [data-r="${r}"][data-c="${c}"]`);
}

// ── Result ────────────────────────────────────────────────────────────────────
function showResult(won) {
  state.gameOver = true;
  updateTurnDisplay();
  const resultTitle = won ? T('victory') : T('defeat');
  const turnIndicator = document.getElementById('turn-indicator');
  turnIndicator.textContent = resultTitle;
  turnIndicator.classList.toggle('opponent-turn', !won);
  document.getElementById('result-icon').textContent = won ? '🏆' : '💥';
  document.getElementById('result-title').textContent = resultTitle;
  document.getElementById('result-sub').textContent = won
    ? T('wonSub')
    : T('lostSub');
  document.getElementById('result-title').style.color = won ? 'var(--accent)' : 'var(--danger)';
  const panel = document.getElementById('result-panel');
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideResult() {
  document.getElementById('result-panel').hidden = true;
}

function playAgain() {
  hideResult();
  if (state.mode === 'single') {
    initPlacement();
    showScreen('screen-difficulty');
  } else if (state.autoLobby) {
    initPlacement();
    showScreen('screen-placement');
  } else {
    showScreen('screen-menu');
  }
}

function leaveGameToMenu() {
  hideResult();
  if (state.autoLobby) socket.emit('auto_lobby_leave');
  state.autoLobby = false;
  state.playerNumber = null;
  state.roomCode = null;
  state.mode = null;
  showScreen('screen-menu');
}

// ── Log ───────────────────────────────────────────────────────────────────────
function logEntry(msg, cls) {
  const log = document.getElementById('game-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + (cls || '');
  entry.textContent = msg;
  log.prepend(entry);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shipName(id) { return (window.t && t('ships.' + id)) || SHIPS.find(s => s.id === id)?.name || 'Ship'; }
const T = (k, p) => (window.t ? t(k, p) : k);
