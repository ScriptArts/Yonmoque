/**
 * @fileoverview CPU対戦用AIモジュール
 *
 * ミニマックス法（アルファベータ枝刈り）を使用して最善手を探索します。
 * 反復深化により、制限時間内で可能な限り深く探索します。
 *
 * @module ai
 */

const {
  BOARD_SIZE,
  MAX_PIECES,
  getCellType,
  getOpponent,
  applyAction,
} = require("./game");

/**
 * 8方向の移動ベクトル
 * 縦・横・斜めすべての方向を含む
 * @type {Array<Array<number>>}
 */
const DIRECTIONS = [
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
 * 斜め方向のみの移動ベクトル
 * 斜めスライド移動で使用
 * @type {Array<Array<number>>}
 */
const DIAG_DIRECTIONS = [
  [1, 1],   // 右下
  [1, -1],  // 左下
  [-1, 1],  // 右上
  [-1, -1], // 左上
];

/**
 * 座標が盤面内かどうかを判定します。
 * @param {number} row - 行番号
 * @param {number} col - 列番号
 * @returns {boolean} 盤面内ならtrue
 */
function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

/**
 * 指定されたプレイヤーが実行可能なすべてのアクションを列挙します。
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - アクションを実行するプレイヤーの色
 * @returns {Array<Object>} 実行可能なアクションの配列
 */
function listActions(state, color) {
  const actions = [];
  const used = new Set();  // 重複防止用

  /**
   * アクションを追加（重複チェック付き）
   * @param {Object} action - 追加するアクション
   * @param {string} key - 重複チェック用のキー
   */
  const addAction = (action, key) => {
    if (!used.has(key)) {
      used.add(key);
      actions.push(action);
    }
  };

  // === 駒を打つアクション ===
  // 持ち駒が残っている場合のみ
  if (state.placed[color] < MAX_PIECES) {
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        // 空きマスに配置可能
        if (state.board[row][col] === null) {
          addAction({ type: "place", color, to: { row, col } }, `p-${row}-${col}`);
        }
      }
    }
  }

  // === 駒を移動するアクション ===
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      // 自分の駒でなければスキップ
      if (state.board[row][col] !== color) {
        continue;
      }

      const from = { row, col };

      // --- 1マス移動（8方向） ---
      for (const [dr, dc] of DIRECTIONS) {
        const toRow = row + dr;
        const toCol = col + dc;

        // 盤面外または既に駒がある場合はスキップ
        if (!inBounds(toRow, toCol)) {
          continue;
        }
        if (state.board[toRow][toCol] !== null) {
          continue;
        }

        addAction(
          { type: "move", color, from, to: { row: toRow, col: toCol } },
          `m-${row}-${col}-${toRow}-${toCol}`
        );
      }

      // --- 斜めスライド移動 ---
      // 自分の色のマス上にいる場合のみ
      if (getCellType(row, col) !== color) {
        continue;
      }

      for (const [dr, dc] of DIAG_DIRECTIONS) {
        let step = 1;
        while (true) {
          const toRow = row + dr * step;
          const toCol = col + dc * step;

          // 盤面外なら終了
          if (!inBounds(toRow, toCol)) {
            break;
          }

          // 自分の色のマスでなければ終了
          if (getCellType(toRow, toCol) !== color) {
            break;
          }

          // 途中に駒があれば終了
          if (state.board[toRow][toCol] !== null) {
            break;
          }

          // 2マス以上の移動のみ有効（1マス移動は上で処理済み）
          if (step >= 2) {
            addAction(
              { type: "move", color, from, to: { row: toRow, col: toCol } },
              `m-${row}-${col}-${toRow}-${toCol}`
            );
          }

          step += 1;
        }
      }
    }
  }

  return actions;
}

/**
 * 盤面上の指定色の駒数をカウントします。
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {'black'|'white'} color - カウントする色
 * @returns {number} 駒の数
 */
function countPieces(board, color) {
  let total = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row][col] === color) {
        total += 1;
      }
    }
  }
  return total;
}

/**
 * 指定色のラインの長さごとの数をカウントします。
 * 評価関数で使用し、4目リーチなどを検出します。
 * @param {Array<Array<string|null>>} board - 盤面
 * @param {'black'|'white'} color - カウントする色
 * @returns {Object} 長さごとのライン数 {1: n, 2: n, 3: n, 4: n, 5: n}
 */
function lineCounts(board, color) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  // 縦・横・斜め（右下、左下）の4方向
  const scanDirs = [
    [1, 0],   // 縦
    [0, 1],   // 横
    [1, 1],   // 右下斜め
    [-1, 1],  // 左下斜め
  ];

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      // 指定色の駒でなければスキップ
      if (board[row][col] !== color) {
        continue;
      }

      for (const [dr, dc] of scanDirs) {
        // ラインの先頭からのみカウント（重複防止）
        const prevRow = row - dr;
        const prevCol = col - dc;
        if (inBounds(prevRow, prevCol) && board[prevRow][prevCol] === color) {
          continue;
        }

        // ラインの長さを計測
        let length = 0;
        let r = row;
        let c = col;
        while (inBounds(r, c) && board[r][c] === color) {
          length += 1;
          r += dr;
          c += dc;
        }

        // 長さ5以上は5としてカウント
        if (length >= 1) {
          counts[Math.min(length, 5)] += 1;
        }
      }
    }
  }

  return counts;
}

/**
 * ゲーム状態を評価し、スコアを返します。
 * 正のスコアは指定プレイヤーに有利、負のスコアは不利を示します。
 *
 * 評価要素:
 * - ラインスコア: 連続した駒の数（4目は高得点、5目はペナルティ）
 * - 駒数スコア: 盤面上の駒の数の差
 * - 機動力スコア: 実行可能なアクション数の差
 *
 * @param {Object} state - 評価するゲーム状態
 * @param {'black'|'white'} color - 評価の基準となるプレイヤーの色
 * @returns {number} 評価スコア（勝利: +100000、敗北: -100000）
 */
function evaluateState(state, color) {
  // 終了状態の場合は勝敗で決定的なスコアを返す
  if (state.status === "finished") {
    if (state.winner === color) {
      return 100000;   // 勝利
    }
    if (state.winner) {
      return -100000;  // 敗北
    }
  }

  const opponent = getOpponent(color);

  // 自分と相手のラインをカウント
  const myLines = lineCounts(state.board, color);
  const oppLines = lineCounts(state.board, opponent);

  // ラインスコアの計算
  // 4目は非常に高い得点、3目、2目、1目も加点
  // 相手の4目は自分より少し高いペナルティ（防御重視）
  const lineScore =
    myLines[4] * 8000 +
    myLines[3] * 420 +
    myLines[2] * 60 +
    myLines[1] * 10 -
    (oppLines[4] * 8200 + oppLines[3] * 440 + oppLines[2] * 70 + oppLines[1] * 10);

  // 駒数スコア（盤面上の駒の差）
  const pieceScore =
    (countPieces(state.board, color) - countPieces(state.board, opponent)) * 5;

  // 機動力スコア（選択肢の多さ）
  const mobilityScore =
    (listActions(state, color).length - listActions(state, opponent).length) * 2;

  return lineScore + pieceScore + mobilityScore;
}

/**
 * ゲーム状態を文字列にシリアライズします。
 * トランスポジションテーブルのキーとして使用。
 * @param {Object} state - シリアライズするゲーム状態
 * @returns {string} シリアライズされた文字列
 */
function serializeState(state) {
  // 盤面を文字列化
  const rows = state.board
    .map((row) =>
      row
        .map((cell) => {
          if (cell === "black") return "b";
          if (cell === "white") return "w";
          return "_";
        })
        .join("")
    )
    .join("/");

  return `${state.turn}|${state.placed.black}|${state.placed.white}|${rows}`;
}

/**
 * ミニマックス法（アルファベータ枝刈り）で最善手を探索します。
 * 反復深化により、制限時間内で可能な限り深く探索します。
 *
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - CPUプレイヤーの色
 * @param {Object} [options={}] - 探索オプション
 * @param {number} [options.maxDepth=4] - 最大探索深度
 * @param {number} [options.timeLimitMs=400] - 制限時間（ミリ秒）
 * @returns {Object|null} 最善手（見つからない場合はnull）
 */
function searchBestMove(state, color, options = {}) {
  const maxDepth = options.maxDepth || 4;
  const timeLimitMs = options.timeLimitMs || 400;
  const deadline = Date.now() + timeLimitMs;

  // トランスポジションテーブル（同一局面のキャッシュ）
  const table = new Map();

  /**
   * 再帰的に局面を評価します（ミニマックス法）
   * @param {Object} current - 現在の状態
   * @param {number} depth - 残り探索深度
   * @param {number} alpha - アルファ値（最大化側の下限）
   * @param {number} beta - ベータ値（最小化側の上限）
   * @returns {Object} 評価結果
   */
  const evaluateAtDepth = (current, depth, alpha, beta) => {
    // 時間切れチェック
    if (Date.now() > deadline) {
      return { score: evaluateState(current, color), timedOut: true };
    }

    // 深度0または終了状態なら評価して返す
    if (depth === 0 || current.status === "finished") {
      return { score: evaluateState(current, color), timedOut: false };
    }

    // トランスポジションテーブルをチェック
    const cacheKey = `${serializeState(current)}|d${depth}`;
    const cached = table.get(cacheKey);
    if (cached && cached.depth >= depth) {
      return { score: cached.score, timedOut: false, bestAction: cached.bestAction };
    }

    // 可能なアクションを列挙
    const actions = listActions(current, current.turn);
    if (actions.length === 0) {
      return { score: evaluateState(current, color), timedOut: false };
    }

    // CPUの手番なら最大化、相手の手番なら最小化
    const maximizing = current.turn === color;
    let bestScore = maximizing ? -Infinity : Infinity;
    let bestAction = null;

    // 各アクションを試行
    for (const action of actions) {
      const result = applyAction(current, action);
      if (!result.ok) {
        continue;
      }

      const next = result.state;
      const child = evaluateAtDepth(next, depth - 1, alpha, beta);

      // 時間切れなら中断
      if (child.timedOut) {
        return { score: 0, timedOut: true };
      }

      if (maximizing) {
        // 最大化ノード
        if (child.score > bestScore) {
          bestScore = child.score;
          bestAction = action;
        }
        alpha = Math.max(alpha, bestScore);
        // ベータカット
        if (alpha >= beta) {
          break;
        }
      } else {
        // 最小化ノード
        if (child.score < bestScore) {
          bestScore = child.score;
          bestAction = action;
        }
        beta = Math.min(beta, bestScore);
        // アルファカット
        if (beta <= alpha) {
          break;
        }
      }
    }

    // 結果をキャッシュ
    table.set(cacheKey, { score: bestScore, depth, bestAction });
    return { score: bestScore, timedOut: false, bestAction };
  };

  // 反復深化: 深度1から徐々に深く探索
  let best = null;
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const result = evaluateAtDepth(state, depth, -Infinity, Infinity);

    // 時間切れなら前回の結果を使用
    if (result.timedOut) {
      break;
    }

    if (result.bestAction) {
      best = result.bestAction;
    }
  }

  // 最善手が見つかった場合は返す
  if (best) {
    return best;
  }

  // フォールバック: 最初の有効なアクションを返す
  const fallback = listActions(state, color);
  return fallback.length > 0 ? fallback[0] : null;
}

module.exports = {
  listActions,
  evaluateState,
  searchBestMove,
};
