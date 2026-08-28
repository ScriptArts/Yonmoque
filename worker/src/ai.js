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
  normalizeState,
} from "./game.js";

/**
 * 探索中の applyAction に渡すオプション。
 *
 * 探索が扱う局面は、入口で1度 normalizeState した状態か、その applyAction の
 * 結果しかない。つまり常に正規化済みなので、1ノードごとの再正規化と
 * 着手時刻の生成を省ける（ここが探索コストのおよそ3割を占めていた）。
 * @type {{trusted: boolean}}
 */
const SEARCH_APPLY = { trusted: true };

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
    // 同じ移動先へ複数の経路がある場合があるため、キーで重複を弾く
    if (!used.has(key)) {
      used.add(key);
      actions.push(action);
    }
  };

  // === 駒を打つアクション ===
  // 持ち駒が残っている場合のみ
  if (state.placed[color] < MAX_PIECES) {
    // 盤面全体を走査し、空きマスをすべて「打つ」手として列挙する
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
  // 盤面全体を走査し、自分の駒を1つずつ移動元として扱う
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      // 自分の駒でなければスキップ
      if (state.board[row][col] !== color) {
        continue;
      }

      const from = { row, col };

      // --- 1マス移動（8方向） ---
      // 隣接8方向それぞれについて、空いていれば移動先にする
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

      // 斜め4方向について、自分の色のマスが続く限り滑れる先を集める
      for (const [dr, dc] of DIAG_DIRECTIONS) {
        let step = 1;
        // 進めなくなる条件（盤外・色違い・駒あり）に当たるまで1マスずつ伸ばす
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
  // 盤面全体を走査して該当色のマスを数える
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

  // 盤面全体を走査し、各マスを起点にラインを数える
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      // 指定色の駒でなければスキップ
      if (board[row][col] !== color) {
        continue;
      }

      // 縦・横・斜め2種の4方向について、そのマスから伸びる長さを測る
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
        // 同じ色が続く限り進み、その長さを数える
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

  // 盤面全体を走査し、空きマス数と自分の駒から動ける先の数を数える
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = board[row][col];

      // 空きマスは「打つ」手の候補になるので別に数える
      if (cell === null) {
        emptyCells += 1;
        continue;
      }
      // 相手の駒はここでは数えない
      if (cell !== color) {
        continue;
      }

      // 自分の駒の隣接8方向のうち、空いている数だけ動ける先がある
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
    // 勝ち・負け・引き分けで決定的なスコアを返す
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
  //
  // 4目の勝ちは「その手で4目が成立した」ときだけなので、盤上に残っている4目は
  // それ自体では勝ちではない。ただし1枚抜いて戻せば成立する2手の勝ち筋であり、
  // 相手はそれを常に防ぎ続けなければならない。よって高い評価のままでよい。
  // （4目の重みを 500〜20000 で振って自己対戦させたところ、1500以上はどれも
  //   互角で、3目(420)に近い500だけが明確に弱かった）
  //
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
  // 各マスを2ビットに詰め、盤面全体を1つの整数にまとめる
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const line = board[row];
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = line[col];
      // 空き=0 / 黒=1 / 白=2
      let bits = 0;
      if (cell === "black") {
        bits = 1;
      } else if (cell !== null) {
        bits = 2;
      }
      code = code * 4 + bits;
    }
  }

  // 手番も1桁で表す（同じ盤面でも手番が違えば別の局面）
  let turnBit = 1;
  if (state.turn === "black") {
    turnBit = 0;
  }

  // 手番と持ち駒の消費数もキーに含める（同じ盤面でも合法手が変わるため）
  return `${code.toString(36)}.${turnBit}${state.placed.black}${state.placed.white}`;
}

/**
 * 予算切れで1手も評価できなかったときに、深さ1で読み直すためのノード数。
 * 1局面の子ノードを見るだけなので、これで足りる。
 */
const RETRY_NODE_BUDGET = 200;

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

  // 着手先の隣接8方向を見て、相手の駒に隣接する手ほど高く評価する
  for (let i = 0; i < DIRECTIONS.length; i += 1) {
    const row = to.row + DIRECTIONS[i][0];
    const col = to.col + DIRECTIONS[i][1];
    // 盤外は評価対象にならない
    if (!inBounds(row, col)) {
      continue;
    }
    const cell = board[row][col];
    // 相手の駒に接する手は挟み（裏返し）につながりやすい
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
 * 反復深化では、1つ浅い深さでの最善手を hint として必ず先頭に置く。
 * これがあるおかげで、深い探索を読み切れずに打ち切っても
 * 「前の深さの最善手か、それより良いと分かった手」しか返らない。
 *
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - 手番の色
 * @param {Object} [hint=null] - 先頭に置く手（1つ浅い深さでの最善手）
 * @returns {Array<Object>} 並べ替え済みのアクション配列
 */
function listRootActions(state, color, hint = null) {
  const actions = listActions(state, color);

  // 各手に並べ替え用のスコアを付ける
  const scored = actions.map((action, index) => {
    // 1つ浅い深さでの最善手は必ず先頭に来るよう最大値にする
    let score;
    if (hint && sameAction(action, hint)) {
      score = Number.POSITIVE_INFINITY;
    } else {
      score = orderingScore(state, action, color);
    }
    return { action, index, score };
  });

  return scored
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
 * @param {Map} [sharedTable=null] - ティックをまたいで使い回す置換表。
 *   省略時はこの探索専用の表を作る。
 * @returns {{evaluate: Function, nodes: Function, aborted: Function}} 探索コンテキスト
 */
function createSearchContext(color, nodeBudget, sharedTable = null) {
  const table = sharedTable || new Map();
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
    // ノード数の予算を使い切ったらこの探索を打ち切る
    if (nodes > nodeBudget) {
      aborted = true;
      return { score: 0, aborted: true };
    }

    // 読み切った深さ、または終局した局面は評価関数の値をそのまま返す
    if (depth === 0 || current.status === "finished") {
      return { score: evaluateState(current, color), aborted: false };
    }

    const alphaOrigin = alpha;
    const key = serializeState(current);
    const cached = table.get(key);

    // 同じ局面を同じ深さ以上で読んだ結果が残っていれば再利用する
    if (cached && cached.depth >= depth) {
      // 確定値なら探索せずにそのまま返せる
      if (cached.flag === TT_EXACT) {
        return { score: cached.score, aborted: false, bestAction: cached.action };
      }
      // 上限・下限の記録なら探索窓を狭めるのに使う
      if (cached.flag === TT_LOWER && cached.score > alpha) {
        alpha = cached.score;
      } else if (cached.flag === TT_UPPER && cached.score < beta) {
        beta = cached.score;
      }
      // 窓が閉じたらこれ以上調べても結果は変わらない
      if (alpha >= beta) {
        return { score: cached.score, aborted: false, bestAction: cached.action };
      }
    }

    const actions = listActions(current, current.turn);
    // 合法手が無い局面はそれ以上進められないので評価値を返す
    if (actions.length === 0) {
      return { score: evaluateState(current, color), aborted: false };
    }

    // 良さそうな手から調べるほど枝を切れる。浅い探索で得た手があれば最優先。
    //
    // 並べ替えは depth>=2 のときだけ行う。葉の直前(depth==1)では子がすべて
    // 評価関数の呼び出しで終わるため、並べ替えの費用のほうが高くつく。
    // 置換表に最善手が残っていれば並べ替えのヒントとして使う
    let hint = null;
    if (cached) {
      hint = cached.action;
    }
    const ordered = actions.length > 1 && depth >= 2;
    let scores = null;
    if (ordered) {
      const turnColor = current.turn;
      // スコアは1手につき1回だけ計算する。
      // 比較関数の中で計算すると O(n log n) 回呼ばれてしまう。
      scores = new Array(actions.length);
      for (let i = 0; i < actions.length; i += 1) {
        // ヒントと同じ手は最優先で調べる
        if (hint && sameAction(actions[i], hint)) {
          scores[i] = Number.POSITIVE_INFINITY;
        } else {
          scores[i] = orderingScore(current, actions[i], turnColor);
        }
      }
    }

    const maximizing = current.turn === color;
    // 最大化側は下限から、最小化側は上限から更新していく
    let bestScore = Infinity;
    if (maximizing) {
      bestScore = -Infinity;
    }
    let bestAction = null;

    // 手を1つずつ試し、アルファベータ窓が閉じた時点で打ち切る
    for (let i = 0; i < actions.length; i += 1) {
      if (ordered) {
        // 未調査の中から最良の手を i 番目へ持ってくる（選択ソートの1ステップ）。
        // 枝刈りで数手見ただけで抜けることが多いため、
        // 最初に全部並べ替えるより実際に触る回数がずっと少なくて済む。
        let pick = i;
        // 未調査の範囲から最もスコアの高い手を探す
        for (let j = i + 1; j < actions.length; j += 1) {
          if (scores[j] > scores[pick]) {
            pick = j;
          }
        }
        // 見つかった手を i 番目と入れ替える
        if (pick !== i) {
          const swapAction = actions[i];
          actions[i] = actions[pick];
          actions[pick] = swapAction;
          const swapScore = scores[i];
          scores[i] = scores[pick];
          scores[pick] = swapScore;
        }
      }

      const action = actions[i];
      // 手を適用して1手先の局面を作る
      const result = applyAction(current, action, SEARCH_APPLY);
      // ルール上成立しない手は読み飛ばす
      if (!result.ok) {
        continue;
      }

      // 1手先の局面を再帰的に評価する
      const child = evaluate(result.state, depth - 1, alpha, beta);
      // 予算切れならこの探索の結果は使えない
      if (child.aborted) {
        return { score: 0, aborted: true };
      }

      // 手番によって、より大きい値・より小さい値のどちらを選ぶかが変わる
      if (maximizing) {
        // より高い評価の手が見つかったら最善手を差し替える
        if (child.score > bestScore) {
          bestScore = child.score;
          bestAction = action;
        }
        // 最大化側の下限（アルファ）を引き上げる
        if (bestScore > alpha) {
          alpha = bestScore;
        }
        // 窓が閉じたら、残りの手を調べても結果は変わらない
        if (alpha >= beta) {
          break;
        }
      } else {
        // より低い評価の手が見つかったら最善手を差し替える
        if (child.score < bestScore) {
          bestScore = child.score;
          bestAction = action;
        }
        // 最小化側の上限（ベータ）を引き下げる
        if (bestScore < beta) {
          beta = bestScore;
        }
        // 窓が閉じたら、残りの手を調べても結果は変わらない
        if (beta <= alpha) {
          break;
        }
      }
    }

    // 1手も成立しなかった場合は評価関数の値をそのまま返す
    if (bestAction === null) {
      return { score: evaluateState(current, color), aborted: false };
    }

    // 得られた値が確定値か、探索窓による上限・下限かを記録して再利用できるようにする
    let flag = TT_EXACT;
    if (bestScore <= alphaOrigin) {
      flag = TT_UPPER;
    } else if (bestScore >= beta) {
      flag = TT_LOWER;
    }
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
 * @param {Object} [options.hintAction=null] - 最初に調べる手（1つ浅い深さでの最善手）
 * @param {Map} [options.table=null] - ティックをまたいで使い回す置換表
 * @returns {Object} 進捗と最善手
 */
function searchRootBatch(rootState, color, options) {
  const depth = options.depth;
  const startIndex = options.startIndex || 0;
  const nodeBudget = options.nodeBudget || 1200;

  // 置換表はティックをまたいで渡された場合のみ使い回す
  let table = null;
  if (options.table instanceof Map) {
    table = options.table;
  }

  // 以降は正規化済みであることを前提に探索する（SEARCH_APPLY 参照）
  const state = normalizeState(rootState);
  const actions = listRootActions(state, color, options.hintAction || null);
  const total = actions.length;
  // 合法手が無ければ探索するものが無い
  if (total === 0) {
    return { done: true, nextIndex: 0, total: 0, bestScore: -Infinity, bestAction: null, nodes: 0 };
  }

  const context = createSearchContext(color, nodeBudget, table);

  // 前のティックから引き継いだ暫定最善値があればそこから再開する
  let bestScore = -Infinity;
  if (typeof options.bestScore === "number") {
    bestScore = options.bestScore;
  }
  let bestAction = options.bestAction || null;
  let index = startIndex;
  let evaluated = 0;

  // 根の手を index から順に評価し、予算を使い切ったところで中断する
  while (index < total) {
    const action = actions[index];
    const result = applyAction(state, action, SEARCH_APPLY);

    // ルール上成立しない手は読み飛ばす
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
      // 深さ1の読み直しに必要なのは高々1手ぶんの子ノードなので、予算は小さくてよい。
      // ここに nodeBudget をそのまま渡すと、1ティックのCPU時間が最悪2倍になる。
      const shallow = createSearchContext(color, Math.min(nodeBudget, RETRY_NODE_BUDGET), table);
      // 深さ1で読み直して、この手を必ず1つは評価しておく
      const retry = shallow.evaluate(result.state, 1, -Infinity, Infinity);
      // 読み直しが成立し、より良い（または初めての）手なら採用する
      if (!retry.aborted && (retry.score > bestScore || bestAction === null)) {
        bestScore = retry.score;
        bestAction = action;
      }
      index += 1;
      evaluated += 1;
      break;
    }

    // より良い（または初めての）手が見つかったら最善手を更新する
    if (child.score > bestScore || bestAction === null) {
      bestScore = child.score;
      bestAction = action;
    }

    index += 1;
    evaluated += 1;

    // 予算を使い切ったらこのティックはここまでにする
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
 * 置換表のエントリ数の上限。
 * 1手ぶんの探索で使い回すだけなので、これを超えたら丸ごと捨てて作り直す。
 */
const TABLE_LIMIT = 30000;

/**
 * CPUの1手ぶんの探索の進捗を作ります。
 *
 * アラームをまたいで持ち回るため、そのまま構造化クローンできる
 * プレーンなオブジェクトにする（置換表は別に持つ）。
 *
 * @param {string} signature - 局面の指紋。別の局面の途中結果を捨てるのに使う
 * @returns {Object} 進捗オブジェクト
 */
function createCpuSearch(signature) {
  return {
    signature,
    ticks: 0,        // 消費したアラームの回数
    depth: 1,        // いま読んでいる深さ
    index: 0,        // その深さで次に調べる根の手
    bestScore: null, // その深さでの暫定最善値（-Infinity は保存できないのでnull）
    bestAction: null,
    action: null,    // 読み切れた最大の深さでの最善手（実際に指す手）
    doneDepth: 0,    // 読み切れた最大の深さ
  };
}

/**
 * CPUの探索を1ティックぶん進めます。
 *
 * 固定の深さで探索すると、予算内に根の手を全部調べ切れなかったときに
 * 「最初の数手の中の最善手」を指してしまい、浅く読んだ場合よりはるかに
 * 弱くなる。そこで深さ1から順に読み、読み切れた深さの結果を必ず手元に
 * 残す（反復深化）。深い探索を打ち切っても、1つ浅い深さの最善手を先頭に
 * 調べているので、返るのはその手か、それより良いと分かった手だけになる。
 *
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - CPUプレイヤーの色
 * @param {Object} progress - createCpuSearch() で作った進捗（破壊的に更新される）
 * @param {Object} config - 探索設定
 * @param {number} config.maxDepth - 読む深さの上限
 * @param {number} config.nodeBudget - 1ティックで使えるノード数
 * @param {Map} [config.table] - ティックをまたいで使い回す置換表
 * @returns {{done: boolean, action: Object|null}} 打ち切ってよいかと、現時点の着手
 */
function stepCpuSearch(state, color, progress, config) {
  // 置換表は渡された場合のみ使い回す
  let table = null;
  if (config.table instanceof Map) {
    table = config.table;
  }
  // 肥大化した置換表は丸ごと捨てて作り直す
  if (table && table.size > TABLE_LIMIT) {
    table.clear();
  }

  // -Infinity は保存に向かないので null で持ち回している。ここで元に戻す
  let resumeScore = -Infinity;
  if (progress.bestScore !== null) {
    resumeScore = progress.bestScore;
  }

  // 現在の深さの続きを1ティックぶんだけ進める
  const batch = searchRootBatch(state, color, {
    depth: progress.depth,
    startIndex: progress.index,
    nodeBudget: config.nodeBudget,
    bestScore: resumeScore,
    bestAction: progress.bestAction,
    hintAction: progress.action,
    table,
  });

  progress.ticks += 1;

  // ±Infinity は保存できないので null に落として持ち回す
  if (Number.isFinite(batch.bestScore)) {
    progress.bestScore = batch.bestScore;
  } else {
    progress.bestScore = null;
  }
  progress.bestAction = batch.bestAction;

  // この深さを読み切れていなければ、次のティックで続きから読む
  if (!batch.done) {
    // この深さはまだ途中。次のティックで続きから読む
    progress.index = batch.nextIndex;
    return { done: false, action: batch.bestAction || progress.action };
  }

  // この深さを読み切ったので、その結果を「実際に指す手」として確定させる
  if (batch.bestAction) {
    progress.action = batch.bestAction;
    progress.doneDepth = progress.depth;
  }
  // 指す手が無い、または深さの上限に達したら思考を終える
  if (!batch.bestAction || progress.depth >= config.maxDepth) {
    return { done: true, action: progress.action };
  }

  // 次の深さへ
  progress.depth += 1;
  progress.index = 0;
  progress.bestScore = null;
  progress.bestAction = null;
  return { done: false, action: progress.action };
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
function searchBestMove(rootState, color, options = {}) {
  const maxDepth = options.maxDepth || 4;
  const nodeBudget = options.nodeBudget || 1200;

  // 以降は正規化済みであることを前提に探索する（SEARCH_APPLY 参照）
  const state = normalizeState(rootState);

  let best = null;
  let reachedDepth = 0;
  let nodes = 0;

  // 反復深化: 深度1から徐々に深く探索
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const remaining = nodeBudget - nodes;
    // ノード数の予算を使い切ったらこれ以上深くは読まない
    if (remaining <= 0) {
      break;
    }

    const result = searchRootBatch(state, color, { depth, nodeBudget: remaining });
    nodes += result.nodes;

    // 手が得られていれば、より深い結果で上書きしていく
    if (result.bestAction) {
      best = result.bestAction;
      if (result.done) {
        reachedDepth = depth;
      }
    }

    // この深さを読み切れなかった場合、さらに深く読んでも意味がない
    if (!result.done) {
      break;
    }
  }

  // 呼び出し側が統計を求めていれば書き戻す
  if (options.stats) {
    options.stats.nodes = nodes;
    options.stats.depth = reachedDepth;
  }

  // 探索で手が決まっていればそれを指す
  if (best) {
    return best;
  }

  // 探索で手が決まらなかった場合は、合法手からランダムに選ぶ
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
  // 種類が違えば別の手
  if (!a || !b || a.type !== b.type) {
    return false;
  }
  // 着手先が違えば別の手
  if (a.to.row !== b.to.row || a.to.col !== b.to.col) {
    return false;
  }
  // 移動の場合は移動元まで一致して初めて同じ手といえる
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
 * depth      … 読む深さの上限（反復深化なので、予算内で届いた深さまでを使う）
 * nodeBudget … 1リクエストあたりに探索するノード数の上限
 * maxTicks   … 1手の思考に使うアラームの回数
 *
 * 無料プランは 1リクエストあたり CPU 10ms なので、深く読むには
 * 探索を複数のアラームに分割するしかない。nodeBudget が1回あたりの
 * CPU時間を、maxTicks が1手にかける総量を決める。
 *
 * depth は「固定の深さ」ではなく上限であることに注意。反復深化により
 * 浅い深さから順に読み、予算が尽きた時点で読み切れている最良の結果を使う。
 * そのため上限を上げても、届かなければ弱くなるだけということはない。
 *
 * @type {Object<string, {depth: number, nodeBudget: number, maxTicks: number}>}
 */
const CPU_LEVELS = {
  easy: { depth: 2, nodeBudget: 600, maxTicks: 1 },
  normal: { depth: 3, nodeBudget: 800, maxTicks: 2 },
  hard: { depth: 4, nodeBudget: 1100, maxTicks: 3 },
  strong: { depth: 5, nodeBudget: 1800, maxTicks: 4 },
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
  // 未知の難易度名が来た場合は最も強い設定にフォールバックする
  let level = "strong";
  if (CPU_LEVELS[levelName]) {
    level = levelName;
  }
  const base = CPU_LEVELS[level];

  /**
   * 環境変数を上限として適用します。
   * @param {number} value - 難易度ごとの値
   * @param {*} raw - 環境変数の値
   * @returns {number} 適用後の値
   */
  const cap = (value, raw) => {
    const limit = Number(raw);
    // 環境変数で有効な上限が指定されている場合のみ切り詰める
    if (Number.isFinite(limit) && limit > 0) {
      return Math.min(value, limit);
    }
    return value;
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
  createCpuSearch,
  stepCpuSearch,
  CPU_LEVELS,
  resolveCpuLevel,
};
