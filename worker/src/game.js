/**
 * @fileoverview ヨンモクゲームのルールとロジックを実装するモジュール
 *
 * ヨンモクは5x5盤面で行う2人対戦ボードゲームです。
 * - 各プレイヤーは6個の持ち駒を使用
 * - 駒を打つか、盤上の駒を移動させる
 * - 移動で4目を成立させると勝ち（打って4目並べても勝ちにはならない）、5目並べると負け
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
 * 隣接8方向の移動ベクトル。
 * 呼び出しごとに配列を作り直すとCPU対戦の探索でそのコストが効いてくるため、
 * モジュール定数として1度だけ確保する。
 * @type {Array<Array<number>>}
 */
const ALL_DIRECTIONS = [
  [1, 0],   // 下
  [-1, 0],  // 上
  [0, 1],   // 右
  [0, -1],  // 左
  [1, 1],   // 右下
  [1, -1],  // 左下
  [-1, 1],  // 右上
  [-1, -1], // 左上
];

/**
 * ライン判定に使う4方向（縦・横・斜め2種）。
 * 逆向きは同じラインなので4方向で足りる。
 * @type {Array<Array<number>>}
 */
const LINE_DIRECTIONS = [
  [1, 0],   // 縦
  [0, 1],   // 横
  [1, 1],   // 右下斜め
  [-1, 1],  // 左下斜め
];

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
    passed: null,                     // 直前にパスしたプレイヤーの色
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
    passed: null,
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
    // 5x5の範囲だけを走査し、想定外の行や値は捨てる
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      const sourceRow = state.board[row];
      // 行が配列でなければその行はすべて空きマスのままにする
      if (!Array.isArray(sourceRow)) {
        continue;
      }
      // 行内の各マスを検証しながら書き写す
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

  // 配置済み駒数は数値以外を0に丸める
  let placedBlack = 0;
  if (Number.isFinite(placed.black)) {
    placedBlack = placed.black;
  }
  let placedWhite = 0;
  if (Number.isFinite(placed.white)) {
    placedWhite = placed.white;
  }

  // 手番は 'white' 以外をすべて黒（先手）として扱う
  let turn = 'black';
  if (state.turn === 'white') {
    turn = 'white';
  }

  // パスした色は既知の2色のみ受け付ける
  let passed = null;
  if (state.passed === 'black' || state.passed === 'white') {
    passed = state.passed;
  }

  return {
    board,
    placed: {
      black: placedBlack,
      white: placedWhite,
    },
    turn,
    status: state.status || 'waiting',
    ready: {
      black: Boolean(ready.black),
      white: Boolean(ready.white),
    },
    winner: state.winner || null,
    result: state.result || null,
    lastMove: state.lastMove || null,
    passed,
  };
}

/**
 * 正規化済みのゲーム状態を複製します。
 *
 * normalizeState は1マスずつ値を検証しながら盤面を作り直すため、
 * 正しいことが分かっている状態のコピーには重すぎる。CPU対戦の探索では
 * 1ノードごとにこのコピーが走るので、検証を省いた複製を使う。
 *
 * @param {Object} state - 正規化済みのゲーム状態
 * @returns {Object} 複製された状態
 */
function cloneState(state) {
  const source = state.board;
  const board = new Array(BOARD_SIZE);
  // 行ごとに浅いコピーを取れば、マスの値は文字列とnullなので複製として十分
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    board[row] = source[row].slice();
  }

  return {
    board,
    placed: { black: state.placed.black, white: state.placed.white },
    turn: state.turn,
    status: state.status,
    ready: { black: state.ready.black, white: state.ready.white },
    winner: state.winner,
    result: state.result,
    lastMove: state.lastMove,
    passed: state.passed,
  };
}

/**
 * 相手の色を取得します。
 * @param {'black'|'white'} color - 現在の色
 * @returns {'black'|'white'} 相手の色
 */
function getOpponent(color) {
  // 黒の相手は白、それ以外（白）の相手は黒
  if (color === 'black') {
    return 'white';
  }
  return 'black';
}

/**
 * 指定色のプレイヤーに合法手が1つでも存在するかを判定します。
 *
 * 「打つ」は持ち駒が残っていて空きマスがあれば可能。
 * 「動かす」は自分の駒の隣接8マスに空きがあれば可能
 * （斜めスライドは経路の1マス目が空いている必要があるため、
 *   1マス移動が全て塞がれている場合はスライドも成立しない）。
 *
 * @param {Object} state - ゲーム状態（正規化済み）
 * @param {'black'|'white'} color - 判定するプレイヤーの色
 * @returns {boolean} 合法手があればtrue
 */
function hasLegalAction(state, color) {
  const board = state.board;
  const placed = state.placed || { black: 0, white: 0 };
  const canPlace = (placed[color] || 0) < MAX_PIECES;

  // 盤面全体を走査し、合法手が1つ見つかった時点で打ち切る
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = board[row][col];

      // 空きマスがあり持ち駒が残っていれば「打つ」が可能
      if (cell === null && canPlace) {
        return true;
      }

      // 自分の駒の隣に空きがあれば「動かす」が可能
      if (cell === color) {
        // 隣接8方向のうち1つでも空いていれば動かせる
        for (const [dr, dc] of ALL_DIRECTIONS) {
          const nextRow = row + dr;
          const nextCol = col + dc;
          if (inBounds(nextRow, nextCol) && board[nextRow][nextCol] === null) {
            return true;
          }
        }
      }
    }
  }

  return false;
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
  const flipped = [];

  // 8方向それぞれについて、相手の駒を挟んでいるかを調べる
  for (const [dr, dc] of ALL_DIRECTIONS) {
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
      // 挟まれた駒をすべて自分の色に変える
      for (const [r, c] of candidates) {
        board[r][c] = color;
        flipped.push([r, c]);
      }
    }
  }

  return flipped;
}

/**
 * 指定したマスを通る、その色の最長ラインの長さを取得します。
 * 縦・横・斜めの4方向について、そのマスを含む連続の長さを両方向に数えます。
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {'black'|'white'} color - チェックする色
 * @param {Array<Array<number>>} cells - 対象のマス [[row, col], ...]
 * @returns {number} 最長ラインの長さ
 */
function getMaxLineThrough(board, color, cells) {
  let maxLength = 0;

  // 変化したマスを1つずつ起点にして、そこを通るラインの長さを測る
  for (const [row, col] of cells) {
    // 自分の色でないマスは起点にならないので読み飛ばす
    if (!inBounds(row, col) || board[row][col] !== color) {
      continue;
    }

    // 縦・横・斜め2種の4方向について長さを数える
    for (const [dr, dc] of LINE_DIRECTIONS) {
      // 対象マス自身を1として、正方向と逆方向の両方に伸ばす
      let length = 1;

      // 正方向へ、同じ色が続く限り数える
      let r = row + dr;
      let c = col + dc;
      while (inBounds(r, c) && board[r][c] === color) {
        length += 1;
        r += dr;
        c += dc;
      }

      // 逆方向へも同様に数える
      r = row - dr;
      c = col - dc;
      while (inBounds(r, c) && board[r][c] === color) {
        length += 1;
        r -= dr;
        c -= dc;
      }

      // これまでで最も長いラインを保持する
      if (length > maxLength) {
        maxLength = length;
      }
    }
  }

  return maxLength;
}

/**
 * 勝敗を評価します。
 * - 5目以上並ぶと負け（打つ・動かすのどちらでも）
 * - 4目並ぶと勝ち。ただし「その手によって4目が成立した」場合のみ。
 *   駒を打って4目並べても勝ちにはならず、盤上に既にある4目は、
 *   別の駒を動かしても勝ちにはならない（そのラインを崩して組み直す必要がある）。
 *
 * 4目・5目とも、その手で自分の色になったマス（移動先＋反転させたマス）を通る
 * ラインだけを見れば足りる:
 * - 4目は「その手で成立した」ものだけが勝ちなので、定義上そこしか見なくてよい
 * - 5目は、直前の局面に5目が無いこと（あれば既に終局している）が前提なので、
 *   新しく5目になり得るのは色が変わったマスを通るラインだけ。駒が減った側の
 *   マスではラインは伸びない
 *
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {'black'|'white'} color - 評価するプレイヤーの色
 * @param {Array<Array<number>>} changedCells - その手で自分の色になったマス
 * @param {boolean} canWin - 4目で勝てる手か（動かす手ならtrue、打つ手ならfalse）
 * @returns {Object} 評価結果
 * @returns {'win'|'lose'|null} return.result - 勝敗結果
 * @returns {number} return.maxLine - 変わったマスを通る最長ラインの長さ
 */
function evaluateOutcome(board, color, changedCells, canWin) {
  const maxLine = getMaxLineThrough(board, color, changedCells);

  if (maxLine >= 5) {
    // 5目以上は負け
    return { result: 'lose', maxLine };
  }
  if (maxLine >= 4 && canWin) {
    // その手で4目が成立した（勝ち）
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
 * @param {Object} [options] - 動作オプション
 * @param {boolean} [options.trusted=false] - 正規化済みの状態を渡していることが
 *   保証されている場合にtrue。正規化と着手時刻の生成を省いて高速化する。
 *   CPU対戦の探索専用で、外部入力を扱う経路では絶対に使わないこと。
 * @returns {Object} 結果オブジェクト
 * @returns {boolean} return.ok - 成功したかどうか
 * @returns {string} [return.error] - 失敗理由
 * @returns {Object} [return.state] - 成功時の新しいゲーム状態
 */
function applyAction(state, action, options) {
  const trusted = Boolean(options && options.trusted);

  // 状態をコピー（信頼できない入力はここで正規化も行う）
  let next;
  if (trusted) {
    next = cloneState(state);
  } else {
    next = normalizeState(state);
  }
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

  // アクションの種類ごとに、盤面を更新する処理を分ける
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

  // 勝敗判定。その手で自分の色になったマス（移動先＋反転したマス）を渡す。
  // 4目の勝ちは動かす手のときだけ成立する。
  const changedCells = [[to.row, to.col]];
  // 反転したマスも「その手で自分の色になったマス」として判定対象に含める
  for (const cell of flipped) {
    changedCells.push(cell);
  }
  const outcome = evaluateOutcome(next.board, color, changedCells, type === 'move');

  // 判定結果に応じて終局処理を行うか、手番を進める
  if (outcome.result === 'lose') {
    // 5目並べてしまった（負け）
    next.status = 'finished';
    next.winner = getOpponent(color);
    next.result = 'five';
  } else if (outcome.result === 'win') {
    // 移動で4目並べた（勝ち）
    next.status = 'finished';
    next.winner = color;
    next.result = 'four';
  } else {
    // ゲーム続行。相手に合法手が無ければパスさせる
    const opponent = getOpponent(color);
    if (hasLegalAction(next, opponent)) {
      next.turn = opponent;
      next.passed = null;
    } else if (hasLegalAction(next, color)) {
      // 相手は打つ手が無いのでパス。手番は自分のまま continue
      next.turn = color;
      next.passed = opponent;
    } else {
      // 双方とも打つ手が無い場合は引き分けで終局
      next.status = 'finished';
      next.winner = null;
      next.result = 'draw';
      next.passed = null;
    }
  }

  // 着手時刻の文字列化は探索では使わないうえ高価なので、trusted では省く。
  let at = null;
  if (!trusted) {
    at = new Date().toISOString();
  }

  // 最後の手を記録する
  next.lastMove = {
    type,
    color,
    from,
    to,
    flipped,
    at,
  };

  return { ok: true, state: next };
}

export {
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
  hasLegalAction,
};
