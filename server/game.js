const BOARD_SIZE = 5;
const MAX_PIECES = 6;

const NEUTRAL_POSITIONS = new Set([
  '0,0',
  '0,4',
  '4,0',
  '4,4',
  '2,2',
]);

const BLACK_POSITIONS = new Set([
  '0,2',
  '1,1',
  '1,3',
  '2,0',
  '2,4',
  '3,1',
  '3,3',
  '4,2',
]);

function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function getCellType(row, col) {
  const key = `${row},${col}`;
  if (NEUTRAL_POSITIONS.has(key)) {
    return 'neutral';
  }
  if (BLACK_POSITIONS.has(key)) {
    return 'black';
  }
  return 'white';
}

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function createWaitingState() {
  return {
    board: createEmptyBoard(),
    placed: { black: 0, white: 0 },
    turn: 'black',
    status: 'waiting',
    ready: { black: false, white: false },
    winner: null,
    result: null,
    lastMove: null,
  };
}

function createNewGameState() {
  return {
    board: createEmptyBoard(),
    placed: { black: 0, white: 0 },
    turn: 'black',
    status: 'playing',
    ready: { black: true, white: true },
    winner: null,
    result: null,
    lastMove: null,
  };
}

function normalizeState(state) {
  if (!state || typeof state !== 'object') {
    return createWaitingState();
  }
  const board = createEmptyBoard();
  if (Array.isArray(state.board)) {
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      const sourceRow = state.board[row];
      if (!Array.isArray(sourceRow)) {
        continue;
      }
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = sourceRow[col];
        if (cell === 'black' || cell === 'white') {
          board[row][col] = cell;
        }
      }
    }
  }
  const placed = state.placed || { black: 0, white: 0 };
  const ready = state.ready || { black: false, white: false };
  return {
    board,
    placed: {
      black: Number.isFinite(placed.black) ? placed.black : 0,
      white: Number.isFinite(placed.white) ? placed.white : 0,
    },
    turn: state.turn === 'white' ? 'white' : 'black',
    status: state.status || 'waiting',
    ready: {
      black: Boolean(ready.black),
      white: Boolean(ready.white),
    },
    winner: state.winner || null,
    result: state.result || null,
    lastMove: state.lastMove || null,
  };
}

function getOpponent(color) {
  return color === 'black' ? 'white' : 'black';
}

function isValidStepMove(board, from, to) {
  const dr = Math.abs(to.row - from.row);
  const dc = Math.abs(to.col - from.col);
  return (dr <= 1 && dc <= 1 && (dr + dc > 0) && inBounds(to.row, to.col));
}

function isValidDiagonalSlide(board, color, from, to) {
  const dr = to.row - from.row;
  const dc = to.col - from.col;
  const distance = Math.abs(dr);
  if (distance <= 1 || distance !== Math.abs(dc)) {
    return false;
  }
  if (getCellType(from.row, from.col) !== color) {
    return false;
  }
  const stepRow = Math.sign(dr);
  const stepCol = Math.sign(dc);
  for (let i = 1; i <= distance; i += 1) {
    const row = from.row + stepRow * i;
    const col = from.col + stepCol * i;
    if (!inBounds(row, col)) {
      return false;
    }
    if (getCellType(row, col) !== color) {
      return false;
    }
    if (i < distance && board[row][col] !== null) {
      return false;
    }
  }
  return true;
}

function flipSandwiched(board, color, origin) {
  const opponent = getOpponent(color);
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  const flipped = [];

  for (const [dr, dc] of directions) {
    const candidates = [];
    let row = origin.row + dr;
    let col = origin.col + dc;
    while (inBounds(row, col) && board[row][col] === opponent) {
      candidates.push([row, col]);
      row += dr;
      col += dc;
    }
    if (candidates.length > 0 && inBounds(row, col) && board[row][col] === color) {
      for (const [r, c] of candidates) {
        board[r][c] = color;
        flipped.push([r, c]);
      }
    }
  }

  return flipped;
}

function getMaxLine(board, color) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 1],
  ];
  let maxLength = 0;

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] !== color) {
        continue;
      }
      for (const [dr, dc] of directions) {
        const prevRow = row - dr;
        const prevCol = col - dc;
        if (inBounds(prevRow, prevCol) && board[prevRow][prevCol] === color) {
          continue;
        }
        let length = 0;
        let r = row;
        let c = col;
        while (inBounds(r, c) && board[r][c] === color) {
          length += 1;
          r += dr;
          c += dc;
        }
        if (length > maxLength) {
          maxLength = length;
        }
      }
    }
  }

  return maxLength;
}

function evaluateOutcome(board, color) {
  const maxLine = getMaxLine(board, color);
  if (maxLine >= 5) {
    return { result: 'lose', maxLine };
  }
  if (maxLine >= 4) {
    return { result: 'win', maxLine };
  }
  return { result: null, maxLine };
}

function applyAction(state, action) {
  const next = normalizeState(state);
  const { type, color } = action;
  if (next.status !== 'playing') {
    return { ok: false, error: 'game_not_active' };
  }
  if (color !== next.turn) {
    return { ok: false, error: 'not_your_turn' };
  }
  if (color !== 'black' && color !== 'white') {
    return { ok: false, error: 'invalid_color' };
  }

  let from = null;
  let to = null;
  let flipped = [];

  if (type === 'place') {
    to = action.to;
    if (!to || !inBounds(to.row, to.col)) {
      return { ok: false, error: 'invalid_target' };
    }
    if (next.placed[color] >= MAX_PIECES) {
      return { ok: false, error: 'no_pieces_left' };
    }
    if (next.board[to.row][to.col] !== null) {
      return { ok: false, error: 'occupied' };
    }
    next.board[to.row][to.col] = color;
    next.placed[color] += 1;
  } else if (type === 'move') {
    from = action.from;
    to = action.to;
    if (!from || !to || !inBounds(from.row, from.col) || !inBounds(to.row, to.col)) {
      return { ok: false, error: 'invalid_target' };
    }
    if (next.board[from.row][from.col] !== color) {
      return { ok: false, error: 'not_your_piece' };
    }
    if (next.board[to.row][to.col] !== null) {
      return { ok: false, error: 'occupied' };
    }
    const stepMove = isValidStepMove(next.board, from, to);
    const diagonalSlide = isValidDiagonalSlide(next.board, color, from, to);
    if (!stepMove && !diagonalSlide) {
      return { ok: false, error: 'invalid_move' };
    }
    next.board[from.row][from.col] = null;
    next.board[to.row][to.col] = color;
    flipped = flipSandwiched(next.board, color, to);
  } else {
    return { ok: false, error: 'invalid_action' };
  }

  const outcome = evaluateOutcome(next.board, color);
  if (outcome.result === 'lose') {
    next.status = 'finished';
    next.winner = getOpponent(color);
    next.result = 'five';
  } else if (outcome.result === 'win') {
    next.status = 'finished';
    next.winner = color;
    next.result = 'four';
  } else {
    next.turn = getOpponent(color);
  }

  next.lastMove = {
    type,
    color,
    from,
    to,
    flipped,
    at: new Date().toISOString(),
  };

  return { ok: true, state: next };
}

module.exports = {
  BOARD_SIZE,
  MAX_PIECES,
  getCellType,
  createEmptyBoard,
  createWaitingState,
  createNewGameState,
  normalizeState,
  applyAction,
  evaluateOutcome,
  getOpponent,
};
