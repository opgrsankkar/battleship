(function exposePlacement(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Placement = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPlacementApi() {
  const DEFAULT_BOARD_SIZE = 10;

  function cellsFor(row, col, size, horizontal, boardSize = DEFAULT_BOARD_SIZE) {
    if (![row, col, size, boardSize].every(Number.isInteger) || size < 1 || boardSize < 1) return null;
    const cells = [];
    for (let offset = 0; offset < size; offset++) {
      const nextRow = horizontal ? row : row + offset;
      const nextCol = horizontal ? col + offset : col;
      if (nextRow < 0 || nextCol < 0 || nextRow >= boardSize || nextCol >= boardSize) return null;
      cells.push([nextRow, nextCol]);
    }
    return cells;
  }

  function cellsForPlacement(placement, boardSize = DEFAULT_BOARD_SIZE) {
    if (!placement) return null;
    return cellsFor(
      placement.row,
      placement.col,
      placement.size,
      placement.horizontal,
      boardSize,
    );
  }

  function canPlace(board, shipId, placement) {
    const cells = cellsForPlacement(placement, board.length);
    return Boolean(cells && cells.every(([row, col]) => {
      const occupant = board[row]?.[col];
      return occupant === 0 || occupant === shipId;
    }));
  }

  function findShip(board, shipId) {
    const occupied = [];
    for (let row = 0; row < board.length; row++) {
      for (let col = 0; col < board[row].length; col++) {
        if (board[row][col] === shipId) occupied.push([row, col]);
      }
    }
    if (!occupied.length) return null;

    const sameRow = occupied.every(([row]) => row === occupied[0][0]);
    const sameCol = occupied.every(([, col]) => col === occupied[0][1]);
    if (!sameRow && !sameCol) return null;

    occupied.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const horizontal = sameRow;
    const placement = {
      row: occupied[0][0],
      col: occupied[0][1],
      size: occupied.length,
      horizontal,
    };
    const expected = cellsForPlacement(placement, board.length);
    if (!expected || expected.some(([row, col], index) => {
      const actual = occupied[index];
      return actual[0] !== row || actual[1] !== col;
    })) return null;

    return { ...placement, cells: occupied.map(cell => [...cell]) };
  }

  function clearShip(board, shipId) {
    const previous = findShip(board, shipId);
    for (let row = 0; row < board.length; row++) {
      for (let col = 0; col < board[row].length; col++) {
        if (board[row][col] === shipId) board[row][col] = 0;
      }
    }
    return previous;
  }

  function placeShip(board, shipId, placement) {
    if (!canPlace(board, shipId, placement)) return false;
    const cells = cellsForPlacement(placement, board.length);
    clearShip(board, shipId);
    cells.forEach(([row, col]) => { board[row][col] = shipId; });
    return true;
  }

  return {
    DEFAULT_BOARD_SIZE,
    cellsFor,
    cellsForPlacement,
    canPlace,
    findShip,
    clearShip,
    placeShip,
  };
}));
