/**
 * @fileoverview ヨンモクゲームのルールとロジックを実装するモジュール
 *
 * ヨンモクは5x5盤面で行う2人対戦ボードゲームです。
 * - 各プレイヤーは6個の持ち駒を使用
 * - 駒を打つか、盤上の駒を移動させる
 * - 4目並べると勝ち、5目並べると負け
 * - 移動で相手の駒を挟むと反転（オセロ風）
 *
 * @module game
 */

/** 盤面のサイズ（5x5） */
const BOARD_SIZE = 5;

/** 各プレイヤーの持ち駒数 */
const MAX_PIECES = 6;

/**
 * 中立マスの位置（四隅と中央）
 * これらのマスはどちらの色でもない特殊マス
 * @type {Set<string>}
 */
const NEUTRAL_POSITIONS = new Set([
  '0,0',  // 左上
  '0,4',  // 右上
  '4,0',  // 左下
  '4,4',  // 右下
  '2,2',  // 中央
]);

/**
 * 黒マスの位置
 * 斜め移動時に黒プレイヤーが利用できるマス
 * @type {Set<string>}
 */
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

/**
 * 座標が盤面内かどうかを判定します。
 * @param {number} row - 行番号（0-4）
 * @param {number} col - 列番号（0-4）
 * @returns {boolean} 盤面内ならtrue
 */
function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

/**
 * 指定座標のマスの種類を取得します。
 * マスの種類は斜め移動の可否に影響します。
 * @param {number} row - 行番号
 * @param {number} col - 列番号
 * @returns {'neutral'|'black'|'white'} マスの種類
 */
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

/**
 * 空の盤面を作成します。
 * @returns {Array<Array<null>>} 5x5のnull配列
 */
function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

/**
 * 待機状態のゲーム状態を作成します。
 * プレイヤーが準備完了するまでの初期状態。
 * @returns {Object} 待機状態のゲーム状態
 */
function createWaitingState() {
  return {
    board: createEmptyBoard(),
    placed: { black: 0, white: 0 },  // 各プレイヤーの配置済み駒数
    turn: 'black',                    // 現在の手番（黒が先手）
    status: 'waiting',                // ゲーム状態
    ready: { black: false, white: false },  // 準備完了フラグ
    winner: null,                     // 勝者
    result: null,                     // 終了理由
    lastMove: null,                   // 最後の手
  };
}

/**
 * 新しいゲームを開始する状態を作成します。
 * 両プレイヤーが準備完了した時に使用。
 * @returns {Object} プレイ中のゲーム状態
 */
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

/**
 * ゲーム状態を正規化します。
 * 不正なデータや欠損フィールドを修正して有効な状態を返します。
 * @param {Object} state - 正規化するゲーム状態
 * @returns {Object} 正規化されたゲーム状態
 */
function normalizeState(state) {
  // 無効な状態は待機状態に初期化
  if (!state || typeof state !== 'object') {
    return createWaitingState();
  }

  // 盤面を正規化
  const board = createEmptyBoard();
  if (Array.isArray(state.board)) {
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      const sourceRow = state.board[row];
      if (!Array.isArray(sourceRow)) {
        continue;
      }
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = sourceRow[col];
        // 有効な値のみコピー
        if (cell === 'black' || cell === 'white') {
          board[row][col] = cell;
        }
      }
    }
  }

  // 配置数と準備状態を正規化
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

/**
 * 相手の色を取得します。
 * @param {'black'|'white'} color - 現在の色
 * @returns {'black'|'white'} 相手の色
 */
function getOpponent(color) {
  return color === 'black' ? 'white' : 'black';
}

/**
 * 1マス移動が有効かどうかを判定します。
 * 隣接8方向への移動を許可。
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {Object} from - 移動元座標
 * @param {Object} to - 移動先座標
 * @returns {boolean} 有効な移動ならtrue
 */
function isValidStepMove(board, from, to) {
  const dr = Math.abs(to.row - from.row);
  const dc = Math.abs(to.col - from.col);
  // 1マス以内で、移動あり、盤面内
  return (dr <= 1 && dc <= 1 && (dr + dc > 0) && inBounds(to.row, to.col));
}

/**
 * 斜めスライド移動が有効かどうかを判定します。
 * 自分の色のマスを連続して斜めに移動できる特殊ルール。
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {'black'|'white'} color - 移動するプレイヤーの色
 * @param {Object} from - 移動元座標
 * @param {Object} to - 移動先座標
 * @returns {boolean} 有効な移動ならtrue
 */
function isValidDiagonalSlide(board, color, from, to) {
  const dr = to.row - from.row;
  const dc = to.col - from.col;
  const distance = Math.abs(dr);

  // 2マス以上で、斜め方向（45度）でなければ無効
  if (distance <= 1 || distance !== Math.abs(dc)) {
    return false;
  }

  // 開始位置が自分の色のマスでなければ無効
  if (getCellType(from.row, from.col) !== color) {
    return false;
  }

  // 移動方向を計算
  const stepRow = Math.sign(dr);
  const stepCol = Math.sign(dc);

  // 経路上のすべてのマスをチェック
  for (let i = 1; i <= distance; i += 1) {
    const row = from.row + stepRow * i;
    const col = from.col + stepCol * i;

    // 盤面外は無効
    if (!inBounds(row, col)) {
      return false;
    }

    // 自分の色のマスでなければ無効
    if (getCellType(row, col) !== color) {
      return false;
    }

    // 途中に駒があれば無効（最終地点は除く）
    if (i < distance && board[row][col] !== null) {
      return false;
    }
  }

  return true;
}

/**
 * 挟まれた相手の駒を反転させます（オセロ風ルール）。
 * 移動後の位置から8方向に相手の駒が挟まれているかチェックし、
 * 挟まれている駒を自分の色に反転させます。
 * @param {Array<Array<string|null>>} board - 盤面（直接変更される）
 * @param {'black'|'white'} color - 移動したプレイヤーの色
 * @param {Object} origin - 移動先の座標
 * @returns {Array<Array<number>>} 反転した駒の座標配列 [[row, col], ...]
 */
function flipSandwiched(board, color, origin) {
  const opponent = getOpponent(color);

  // 8方向をチェック
  const directions = [
    [1, 0],   // 下
    [-1, 0],  // 上
    [0, 1],   // 右
    [0, -1],  // 左
    [1, 1],   // 右下
    [1, -1],  // 左下
    [-1, 1],  // 右上
    [-1, -1], // 左上
  ];

  const flipped = [];

  for (const [dr, dc] of directions) {
    const candidates = [];
    let row = origin.row + dr;
    let col = origin.col + dc;

    // 相手の駒が続く限り候補に追加
    while (inBounds(row, col) && board[row][col] === opponent) {
      candidates.push([row, col]);
      row += dr;
      col += dc;
    }

    // 相手の駒の後に自分の駒があれば挟んでいる
    if (candidates.length > 0 && inBounds(row, col) && board[row][col] === color) {
      // 挟まれた駒を反転
      for (const [r, c] of candidates) {
        board[r][c] = color;
        flipped.push([r, c]);
      }
    }
  }

  return flipped;
}

/**
 * 指定色の最長ライン（連続した駒の数）を取得します。
 * 縦・横・斜めの4方向で最も長い連続を探します。
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {'black'|'white'} color - チェックする色
 * @returns {number} 最長ラインの長さ
 */
function getMaxLine(board, color) {
  // 縦・横・斜め（右下、左下）の4方向
  const directions = [
    [1, 0],   // 縦
    [0, 1],   // 横
    [1, 1],   // 右下斜め
    [-1, 1],  // 左下斜め
  ];

  let maxLength = 0;

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      // 指定色の駒でなければスキップ
      if (board[row][col] !== color) {
        continue;
      }

      for (const [dr, dc] of directions) {
        // ラインの先頭からのみカウント（重複防止）
        const prevRow = row - dr;
        const prevCol = col - dc;
        if (inBounds(prevRow, prevCol) && board[prevRow][prevCol] === color) {
          continue;
        }

        // ラインの長さをカウント
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

/**
 * 勝敗を評価します。
 * - 5目以上並ぶと負け
 * - 4目並ぶと勝ち
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {'black'|'white'} color - 評価するプレイヤーの色
 * @returns {Object} 評価結果
 * @returns {'win'|'lose'|null} return.result - 勝敗結果
 * @returns {number} return.maxLine - 最長ラインの長さ
 */
function evaluateOutcome(board, color) {
  const maxLine = getMaxLine(board, color);

  if (maxLine >= 5) {
    // 5目以上は負け
    return { result: 'lose', maxLine };
  }
  if (maxLine >= 4) {
    // 4目は勝ち
    return { result: 'win', maxLine };
  }

  // 勝敗なし
  return { result: null, maxLine };
}

/**
 * アクション（駒を打つ or 移動する）を適用します。
 * ゲームロジックの中核となる関数。
 * @param {Object} state - 現在のゲーム状態
 * @param {Object} action - 適用するアクション
 * @param {'place'|'move'} action.type - アクションの種類
 * @param {'black'|'white'} action.color - アクションを行うプレイヤーの色
 * @param {Object} [action.from] - 移動元座標（moveの場合のみ）
 * @param {Object} action.to - 移動先座標
 * @returns {Object} 結果オブジェクト
 * @returns {boolean} return.ok - 成功したかどうか
 * @returns {string} [return.error] - 失敗理由
 * @returns {Object} [return.state] - 成功時の新しいゲーム状態
 */
function applyAction(state, action) {
  // 状態を正規化してコピー
  const next = normalizeState(state);
  const { type, color } = action;

  // ゲームが進行中でなければ拒否
  if (next.status !== 'playing') {
    return { ok: false, error: 'game_not_active' };
  }

  // 手番でなければ拒否
  if (color !== next.turn) {
    return { ok: false, error: 'not_your_turn' };
  }

  // 無効な色は拒否
  if (color !== 'black' && color !== 'white') {
    return { ok: false, error: 'invalid_color' };
  }

  let from = null;
  let to = null;
  let flipped = [];

  if (type === 'place') {
    // === 駒を打つ ===
    to = action.to;

    // 座標チェック
    if (!to || !inBounds(to.row, to.col)) {
      return { ok: false, error: 'invalid_target' };
    }

    // 持ち駒チェック
    if (next.placed[color] >= MAX_PIECES) {
      return { ok: false, error: 'no_pieces_left' };
    }

    // 空きマスチェック
    if (next.board[to.row][to.col] !== null) {
      return { ok: false, error: 'occupied' };
    }

    // 駒を配置
    next.board[to.row][to.col] = color;
    next.placed[color] += 1;

  } else if (type === 'move') {
    // === 駒を移動する ===
    from = action.from;
    to = action.to;

    // 座標チェック
    if (!from || !to || !inBounds(from.row, from.col) || !inBounds(to.row, to.col)) {
      return { ok: false, error: 'invalid_target' };
    }

    // 自分の駒かチェック
    if (next.board[from.row][from.col] !== color) {
      return { ok: false, error: 'not_your_piece' };
    }

    // 移動先が空きマスかチェック
    if (next.board[to.row][to.col] !== null) {
      return { ok: false, error: 'occupied' };
    }

    // 移動が有効かチェック（1マス移動 or 斜めスライド）
    const stepMove = isValidStepMove(next.board, from, to);
    const diagonalSlide = isValidDiagonalSlide(next.board, color, from, to);
    if (!stepMove && !diagonalSlide) {
      return { ok: false, error: 'invalid_move' };
    }

    // 駒を移動
    next.board[from.row][from.col] = null;
    next.board[to.row][to.col] = color;

    // 挟まれた駒を反転
    flipped = flipSandwiched(next.board, color, to);

  } else {
    return { ok: false, error: 'invalid_action' };
  }

  // 勝敗判定
  const outcome = evaluateOutcome(next.board, color);
  if (outcome.result === 'lose') {
    // 5目並べてしまった（負け）
    next.status = 'finished';
    next.winner = getOpponent(color);
    next.result = 'five';
  } else if (outcome.result === 'win') {
    // 4目並べた（勝ち）
    next.status = 'finished';
    next.winner = color;
    next.result = 'four';
  } else {
    // ゲーム続行、手番交代
    next.turn = getOpponent(color);
  }

  // 最後の手を記録
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
