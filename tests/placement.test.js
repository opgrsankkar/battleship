const test = require('node:test');
const assert = require('node:assert/strict');
const Placement = require('../public/placement.js');

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(10).fill(0));
}

test('cellsFor returns horizontal and vertical cells', () => {
  assert.deepEqual(Placement.cellsFor(2, 3, 3, true), [[2, 3], [2, 4], [2, 5]]);
  assert.deepEqual(Placement.cellsFor(2, 3, 3, false), [[2, 3], [3, 3], [4, 3]]);
});

test('cellsFor rejects placements outside the board', () => {
  assert.equal(Placement.cellsFor(9, 8, 3, true), null);
  assert.equal(Placement.cellsFor(8, 9, 3, false), null);
  assert.equal(Placement.cellsFor(-1, 0, 2, true), null);
});

test('placeShip writes a valid placement and findShip reconstructs it', () => {
  const board = emptyBoard();
  assert.equal(Placement.placeShip(board, 3, { row: 4, col: 2, size: 3, horizontal: true }), true);
  assert.deepEqual(Placement.findShip(board, 3), {
    row: 4,
    col: 2,
    size: 3,
    horizontal: true,
    cells: [[4, 2], [4, 3], [4, 4]],
  });
});

test('placeShip rejects collisions without changing either ship', () => {
  const board = emptyBoard();
  Placement.placeShip(board, 1, { row: 2, col: 2, size: 5, horizontal: true });
  const before = board.map(row => [...row]);
  assert.equal(Placement.placeShip(board, 2, { row: 0, col: 4, size: 4, horizontal: false }), false);
  assert.deepEqual(board, before);
});

test('placeShip can move a ship across its own occupied cells', () => {
  const board = emptyBoard();
  Placement.placeShip(board, 5, { row: 5, col: 2, size: 2, horizontal: true });
  assert.equal(Placement.placeShip(board, 5, { row: 5, col: 3, size: 2, horizontal: true }), true);
  assert.equal(board[5][2], 0);
  assert.equal(board[5][3], 5);
  assert.equal(board[5][4], 5);
});

test('clearShip returns the previous placement and clears all cells', () => {
  const board = emptyBoard();
  Placement.placeShip(board, 4, { row: 1, col: 7, size: 3, horizontal: false });
  const previous = Placement.clearShip(board, 4);
  assert.equal(previous.row, 1);
  assert.equal(previous.col, 7);
  assert.equal(previous.horizontal, false);
  assert.equal(board.flat().includes(4), false);
});

test('findShip rejects malformed non-contiguous ship data', () => {
  const board = emptyBoard();
  board[1][1] = 2;
  board[1][3] = 2;
  assert.equal(Placement.findShip(board, 2), null);
});
