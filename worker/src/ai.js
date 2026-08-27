/**
 * @fileoverview CPU対戦用AIモジュール
 *
 * ミニマックス法（アルファベータ枝刈り）を使用して最善手を探索します。
 * 反復深化により、制限時間内で可能な限り深く探索します。
 *
 * @module ai
 */

import {
  BOARD_SIZE,
  MAX_PIECES,
  getCellType,
  getOpponent,
  applyAction,
} from "./game.js";

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
 * 実行可能な手数の概算を返します。
 *
 * 正確な手数は listActions() で得られますが、末端評価から毎回呼ぶには重いため、
 * 「自分の駒に隣接する空きマスの数」＋「持ち駒が残っていれば空きマスの数」で近似します。
 * 斜めスライドは数えませんが、評価は差分でしか使わないため実用上問題ありません。
 *
 * @param {Object} state - ゲーム状態
 * @param {'black'|'white'} color - 対象プレイヤーの色
 * @returns {number} 手数の概算
 */
function countMobility(state, color) {
  const board = state.board;
  let mobility = 0;
  let emptyCells = 0;

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = board[row][col];

      if (cell === null) {
        emptyCells += 1;
        continue;
      }
      if (cell !== color) {
        continue;
      }

      for (const [dr, dc] of DIRECTIONS) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (inBounds(nextRow, nextCol) && board[nextRow][nextCol] === null) {
          mobility += 1;
        }
      }
    }
  }

  // 持ち駒が残っていれば空きマスすべてが「打つ」手になる
  if ((state.placed[color] || 0) < MAX_PIECES) {
    mobility += emptyCells;
  }

  return mobility;
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
    return 0;          // 引き分け（双方とも合法手なし）
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
  // listActions() は配列とSetを確保するため末端評価で呼ぶには重すぎる。
  // 隣接する空きマス数＋打てる手数による近似で代用する。
  const mobilityScore =
    (countMobility(state, color) - countMobility(state, opponent)) * 2;

  return lineScore + pieceScore + mobilityScore;
}

/**
 * 盤面をトランスポジションテーブル用のキーに変換します。
 *
 * 以前は board.map().join() で文字列を組み立てていたが、探索ノードごとに
 * 中間配列と文字列を作るため、そこが探索の主なコストになっていた。
 * 1マス2ビット・25マスで50ビットに収め、Number として扱う。
 * （53ビットまでは倍精度で正確に整数を表せる）
 *
 * @param {Object} state - シリアライズするゲーム状態
 * @returns {string} キー文字列
 */
function serializeState(state) {
  const board = state.board;
  let code = 0;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const line = board[row];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = line[col];
      // 空き=0 / 黒=1 / 白=2
      const bits = cell === null ? 0 : cell === "black" ? 1 : 2;
      code = code * 4 + bits;
    }
  }
  // 手番と持ち駒の消費数もキーに含める（同じ盤面でも合法手が変わるため）
  return `${code.toString(36)}.${state.turn === "black" ? 0 : 1}${state.placed.black}${state.placed.white}`;
}

/** トランスポジションテーブルの評価値の種類 */
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

/**
 * 手の並べ替え用のスコアを付けます。
 *
 * アルファベータ枝刈りは「良い手を先に調べる」ほど枝を切れるため、
 * 探索の深さは並べ替えの質でほぼ決まる。applyAction は重いので、
 * 着手先の周囲を見るだけの軽い推定に留める。
 *
 * @param {Object} state - 現在の状態
 * @param {Object} action - 評価する手
 * @param {'black'|'white'} color - 手番の色
 * @returns {number} スコア（大きいほど先に調べる）
 */
function orderingScore(state, action, color) {
  const to = action.to;
  const board = state.board;
  const opponent = getOpponent(color);
  let score = 0;

  // 相手の駒に隣接する手は挟み（裏返し）につながりやすい
  for (let i = 0; i < DIRECTIONS.length; i += 1) {
    const row = to.row + DIRECTIONS[i][0];
    const col = to.col + DIRECTIONS[i][1];
    if (!inBounds(row, col)) {
      continue;
    }
    const cell = board[row][col];
    if (cell === opponent) {
      score += 4;
    } else if (cell === color) {
      score += 1;
    }
  }

  // 自分の色のマスは斜めスライドの起点になるので価値が高い
  if (getCellType(to.row, to.col) === color) {
    score += 2;
  }

  // 中央寄りを優先
  score += 2 - (Math.abs(to.row - 2) + Math.abs(to.col - 2)) / 2;

  return score;
}

/**
 * 根の手を評価順に並べて返します。
 *
 * 分割探索では毎回このリストの index で再開するので、
 * 同じ局面なら必ず同じ順序になる必要がある（乱数を使わない）。
 *
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - 手番の色
 * @returns {Array<Object>} 並べ替え済みのアクション配列
 */
function listRootActions(state, color) {
  const actions = listActions(state, color);
  return actions
    .map((action, index) => ({ action, index, score: orderingScore(state, action, color) }))
    // 同点時は元の順序を保って安定させる
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.action);
}

/**
 * アルファベータ探索の本体を作ります。
 *
 * 探索量の制御に時間ではなくノード数を使う理由:
 * Cloudflare Workers では Date.now() が「最後のI/Oの時刻」を返し、
 * 同期処理の途中では進まない（サイドチャネル対策）。そのため
 * 経過時間による打ち切りはWorkers上では一切機能しない。
 * ノード数なら決定的に効くうえ、CPU時間ともほぼ比例する。
 *
 * @param {'black'|'white'} color - CPUプレイヤーの色（最大化する側）
 * @param {number} nodeBudget - 探索するノード数の上限
 * @returns {{evaluate: Function, nodes: Function, aborted: Function}} 探索コンテキスト
 */
function createSearchContext(color, nodeBudget) {
  const table = new Map();
  let nodes = 0;
  let aborted = false;

  /**
   * 再帰的に局面を評価します（ミニマックス法）
   * @param {Object} current - 現在の状態
   * @param {number} depth - 残り探索深度
   * @param {number} alpha - アルファ値（最大化側の下限）
   * @param {number} beta - ベータ値（最小化側の上限）
   * @returns {Object} 評価結果
   */
  const evaluate = (current, depth, alpha, beta) => {
    nodes += 1;
    if (nodes > nodeBudget) {
      aborted = true;
      return { score: 0, aborted: true };
    }

    if (depth === 0 || current.status === "finished") {
      return { score: evaluateState(current, color), aborted: false };
    }

    const alphaOrigin = alpha;
    const key = serializeState(current);
    const cached = table.get(key);

    if (cached && cached.depth >= depth) {
      if (cached.flag === TT_EXACT) {
        return { score: cached.score, aborted: false, bestAction: cached.action };
      }
      if (cached.flag === TT_LOWER && cached.score > alpha) {
        alpha = cached.score;
      } else if (cached.flag === TT_UPPER && cached.score < beta) {
        beta = cached.score;
      }
      if (alpha >= beta) {
        return { score: cached.score, aborted: false, bestAction: cached.action };
      }
    }

    const actions = listActions(current, current.turn);
    if (actions.length === 0) {
      return { score: evaluateState(current, color), aborted: false };
    }

    // 良さそうな手から調べるほど枝を切れる。浅い探索で得た手があれば最優先。
    //
    // 並べ替えは depth>=2 のときだけ行う。葉の直前(depth==1)では子がすべて
    // 評価関数の呼び出しで終わるため、並べ替えの費用のほうが高くつく。
    const hint = cached ? cached.action : null;
    if (actions.length > 1 && depth >= 2) {
      const turnColor = current.turn;
      // スコアは1手につき1回だけ計算する。
      // 比較関数の中で計算すると O(n log n) 回呼ばれてしまう。
      const scores = new Array(actions.length);
      for (let i = 0; i < actions.length; i += 1) {
        scores[i] = hint && sameAction(actions[i], hint)
          ? Number.POSITIVE_INFINITY
          : orderingScore(current, actions[i], turnColor);
      }
      // 挿入ソート。手の数はせいぜい数十なので、配列を作り直すより速い。
      for (let i = 1; i < actions.length; i += 1) {
        const action = actions[i];
        const score = scores[i];
        let j = i - 1;
        while (j >= 0 && scores[j] < score) {
          actions[j + 1] = actions[j];
          scores[j + 1] = scores[j];
          j -= 1;
        }
        actions[j + 1] = action;
        scores[j + 1] = score;
      }
    }

    const maximizing = current.turn === color;
    let bestScore = maximizing ? -Infinity : Infinity;
    let bestAction = null;

    for (const action of actions) {
      const result = applyAction(current, action);
      if (!result.ok) {
        continue;
      }

      const child = evaluate(result.state, depth - 1, alpha, beta);
      if (child.aborted) {
        return { score: 0, aborted: true };
      }

      if (maximizing) {
        if (child.score > bestScore) {
          bestScore = child.score;
          bestAction = action;
        }
        if (bestScore > alpha) {
          alpha = bestScore;
        }
        if (alpha >= beta) {
          break;
        }
      } else {
        if (child.score < bestScore) {
          bestScore = child.score;
          bestAction = action;
        }
        if (bestScore < beta) {
          beta = bestScore;
        }
        if (beta <= alpha) {
          break;
        }
      }
    }

    if (bestAction === null) {
      return { score: evaluateState(current, color), aborted: false };
    }

    const flag =
      bestScore <= alphaOrigin ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
    table.set(key, { depth, score: bestScore, flag, action: bestAction });

    return { score: bestScore, aborted: false, bestAction };
  };

  return {
    evaluate,
    nodes: () => nodes,
    aborted: () => aborted,
  };
}

/**
 * 根の手を index から順に評価します。ノード数の予算を使い切ったら中断し、
 * 次に再開すべき index を返します。
 *
 * 1回のリクエストで使えるCPU時間は無料プランで10msしかないため、
 * 深い探索は複数のアラームに分割して進める。分割しても各リクエストの
 * CPU時間は予算で頭打ちになる。
 *
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - CPUプレイヤーの色
 * @param {Object} options - オプション
 * @param {number} options.depth - 探索深度
 * @param {number} [options.startIndex=0] - 再開する根の手のindex
 * @param {number} [options.nodeBudget=1200] - このバッチで使えるノード数
 * @param {number} [options.bestScore=-Infinity] - ここまでの最善評価値
 * @param {Object} [options.bestAction=null] - ここまでの最善手
 * @returns {Object} 進捗と最善手
 */
function searchRootBatch(state, color, options) {
  const depth = options.depth;
  const startIndex = options.startIndex || 0;
  const nodeBudget = options.nodeBudget || 1200;

  const actions = listRootActions(state, color);
  const total = actions.length;
  if (total === 0) {
    return { done: true, nextIndex: 0, total: 0, bestScore: -Infinity, bestAction: null, nodes: 0 };
  }

  const context = createSearchContext(color, nodeBudget);
  let bestScore = typeof options.bestScore === "number" ? options.bestScore : -Infinity;
  let bestAction = options.bestAction || null;
  let index = startIndex;
  let evaluated = 0;

  while (index < total) {
    const action = actions[index];
    const result = applyAction(state, action);

    if (!result.ok) {
      index += 1;
      continue;
    }

    // これまでの最善値をアルファに使う（根は最大化なので有効）
    const child = context.evaluate(result.state, depth - 1, bestScore, Infinity);

    if (child.aborted) {
      // 予算切れ。この手はまだ評価できていないので次のティックで調べ直す。
      //
      // ただし1手も評価できないまま終わると永久に進まないので、その場合だけは
      // 浅い深さで評価し直して必ず1手ぶん進める。
      if (evaluated > 0) {
        break;
      }
      const shallow = createSearchContext(color, nodeBudget);
      const retry = shallow.evaluate(result.state, 1, -Infinity, Infinity);
      if (!retry.aborted && (retry.score > bestScore || bestAction === null)) {
        bestScore = retry.score;
        bestAction = action;
      }
      index += 1;
      evaluated += 1;
      break;
    }

    if (child.score > bestScore || bestAction === null) {
      bestScore = child.score;
      bestAction = action;
    }

    index += 1;
    evaluated += 1;

    if (context.nodes() >= nodeBudget) {
      break;
    }
  }

  return {
    done: index >= total,
    nextIndex: index,
    total,
    bestScore,
    bestAction,
    nodes: context.nodes(),
  };
}

/**
 * ミニマックス法（アルファベータ枝刈り）で最善手を探索します。
 * 反復深化により、ノード数の予算内で可能な限り深く探索します。
 *
 * 1リクエストで完結させたい場面（浅い保険の探索など）で使います。
 * 深い探索は searchRootBatch で分割してください。
 *
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - CPUプレイヤーの色
 * @param {Object} [options={}] - 探索オプション
 * @param {number} [options.maxDepth=4] - 最大探索深度
 * @param {number} [options.nodeBudget=1200] - 探索するノード数の上限
 * @param {Object} [options.stats] - 探索結果の統計を書き戻すオブジェクト（任意）
 * @returns {Object|null} 最善手（見つからない場合はnull）
 */
function searchBestMove(state, color, options = {}) {
  const maxDepth = options.maxDepth || 4;
  const nodeBudget = options.nodeBudget || 1200;

  let best = null;
  let reachedDepth = 0;
  let nodes = 0;

  // 反復深化: 深度1から徐々に深く探索
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const remaining = nodeBudget - nodes;
    if (remaining <= 0) {
      break;
    }

    const result = searchRootBatch(state, color, { depth, nodeBudget: remaining });
    nodes += result.nodes;

    if (result.bestAction) {
      best = result.bestAction;
      if (result.done) {
        reachedDepth = depth;
      }
    }

    if (!result.done) {
      break;
    }
  }

  if (options.stats) {
    options.stats.nodes = nodes;
    options.stats.depth = reachedDepth;
  }

  if (best) {
    return best;
  }

  const fallback = listActions(state, color);
  if (fallback.length === 0) {
    return null;
  }
  return fallback[Math.floor(Math.random() * fallback.length)];
}

/**
 * 2つのアクションが同じ手かどうかを判定します。
 * @param {Object} a - アクションA
 * @param {Object} b - アクションB
 * @returns {boolean} 同じ手ならtrue
 */
function sameAction(a, b) {
  if (!a || !b || a.type !== b.type) {
    return false;
  }
  if (a.to.row !== b.to.row || a.to.col !== b.to.col) {
    return false;
  }
  if (a.type === "move") {
    return a.from.row === b.from.row && a.from.col === b.from.col;
  }
  return true;
}

// =============================================================================
// CPU難易度
// =============================================================================

/**
 * CPUの難易度ごとの探索設定。
 *
 * depth      … 読む手数
 * nodeBudget … 1リクエストあたりに探索するノード数の上限
 * maxTicks   … 1手の思考に使うアラームの回数
 *
 * 無料プランは 1リクエストあたり CPU 10ms なので、深く読むには
 * 探索を複数のアラームに分割するしかない。nodeBudget が1回あたりの
 * CPU時間を、maxTicks が1手にかける総量を決める。
 *
 * @type {Object<string, {depth: number, nodeBudget: number, maxTicks: number}>}
 */
const CPU_LEVELS = {
  easy: { depth: 2, nodeBudget: 600, maxTicks: 1 },
  normal: { depth: 3, nodeBudget: 800, maxTicks: 2 },
  hard: { depth: 3, nodeBudget: 1000, maxTicks: 3 },
  strong: { depth: 3, nodeBudget: 1000, maxTicks: 4 },
};

/**
 * 難易度名と環境変数から、実際に使う探索設定を決定します。
 *
 * CPU_MAX_DEPTH / CPU_NODE_BUDGET / CPU_MAX_TICKS が設定されている場合は
 * 上限として作用し、難易度ごとの値がそれを超えないよう切り詰めます。
 *
 * @param {string} levelName - 難易度名（easy/normal/hard/strong）
 * @param {Object} [env={}] - Workers の環境変数
 * @returns {{level: string, depth: number, nodeBudget: number, maxTicks: number}} 探索設定
 */
function resolveCpuLevel(levelName, env = {}) {
  const level = CPU_LEVELS[levelName] ? levelName : "strong";
  const base = CPU_LEVELS[level];

  /**
   * 環境変数を上限として適用します。
   * @param {number} value - 難易度ごとの値
   * @param {*} raw - 環境変数の値
   * @returns {number} 適用後の値
   */
  const cap = (value, raw) => {
    const limit = Number(raw);
    return Number.isFinite(limit) && limit > 0 ? Math.min(value, limit) : value;
  };

  return {
    level,
    depth: cap(base.depth, env.CPU_MAX_DEPTH),
    nodeBudget: cap(base.nodeBudget, env.CPU_NODE_BUDGET),
    maxTicks: cap(base.maxTicks, env.CPU_MAX_TICKS),
  };
}

export {
  serializeState as positionKey,
  listActions,
  listRootActions,
  evaluateState,
  searchBestMove,
  searchRootBatch,
  CPU_LEVELS,
  resolveCpuLevel,
};
