/**
 * @fileoverview CPU対戦用AIモジュール
 *
 * ミニマックス法（アルファベータ枝刈り）を使用して最善手を探索します。
 * 反復深化により、ノード数の予算内で可能な限り深く探索します。
 *
 * 探索は Durable Object のアラーム1回の中で最後まで行います。
 * 無料プランでも Durable Object には 1リクエスト10ms の CPU 制限がかからないことを
 * 実測で確かめてあります（docs/cloudflare-cpu-limit.md）。
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
 * 勝敗が決まった局面の評価値。
 * 終局していない局面の評価値はこれより十分小さいので、絶対値がこれ以上なら勝敗が読み切れている。
 */
const WIN_SCORE = 100000;

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
 * ラインを数える4方向（縦・横・斜め2種）。逆向きは同じラインなので4方向で足りる。
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
 * @param {number} row - 行番号
 * @param {number} col - 列番号
 * @returns {boolean} 盤面内ならtrue
 */
function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

// =============================================================================
// 評価関数用の早見表
// =============================================================================
//
// 評価関数は探索の末端で毎回呼ばれ、探索時間の半分以上を占めていた。
// 盤面の形は固定なので、マスの並びや隣接関係は起動時に1度だけ求めておき、
// 評価のたびに座標計算や配列の確保をしないようにする。
// マスは「row * BOARD_SIZE + col」の通し番号で扱う。

/** 盤面のマスの数 */
const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/** 通し番号から行を引く表 */
const CELL_ROW = new Int8Array(CELL_COUNT);

/** 通し番号から列を引く表 */
const CELL_COL = new Int8Array(CELL_COUNT);

/**
 * 各マスに隣接するマスの通し番号
 * @type {Array<Int8Array>}
 */
const NEIGHBORS = [];

// 全マスについて、行・列と隣接マスの一覧を作る
for (let index = 0; index < CELL_COUNT; index += 1) {
  const row = Math.floor(index / BOARD_SIZE);
  const col = index % BOARD_SIZE;
  CELL_ROW[index] = row;
  CELL_COL[index] = col;

  const list = [];
  // 隣接8方向のうち盤面内のマスだけを集める
  for (const [dr, dc] of DIRECTIONS) {
    if (inBounds(row + dr, col + dc)) {
      list.push((row + dr) * BOARD_SIZE + (col + dc));
    }
  }
  NEIGHBORS.push(Int8Array.from(list));
}

/**
 * 縦・横・斜め2種の、盤端から盤端までの列（通し番号の並び）。
 * 連続した同色の駒（ライン）は、これらの列を端から順に見れば漏れなく数えられる。
 * @type {Array<Int8Array>}
 */
const LINES = [];

// 4方向それぞれについて、列の先頭になるマスから盤端まで伸ばして列を作る
for (const [dr, dc] of LINE_DIRECTIONS) {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      // 1つ手前が盤面内なら列の途中なので、ここからは作らない
      if (inBounds(row - dr, col - dc)) {
        continue;
      }
      const line = [];
      let r = row;
      let c = col;
      // 盤端に達するまで同じ方向へ進む
      while (inBounds(r, c)) {
        line.push(r * BOARD_SIZE + c);
        r += dr;
        c += dc;
      }
      LINES.push(Int8Array.from(line));
    }
  }
}

/** 評価中に盤面を数値へ置き換えておく作業領域（空き=0 / 自分=1 / 相手=2） */
const CELL_CODES = new Int8Array(CELL_COUNT);

/** 自分のラインの長さごとの点数（添字がラインの長さ。5以上は5として扱う） */
const MY_LINE_SCORES = [0, 10, 60, 420, 8000, 8000];

/** 相手のラインの長さごとの点数（自分より少し重くして防御を優先させる） */
const OPPONENT_LINE_SCORES = [0, 10, 70, 440, 8200, 8200];

// =============================================================================
// 合法手の列挙と局面評価
// =============================================================================

/**
 * 指定されたプレイヤーが実行可能なすべてのアクションを列挙します。
 *
 * 1マス移動の行き先は隣接8マス、斜めスライドの行き先は2マス以上先なので、
 * 同じ手が2回列挙されることは無い（重複チェックは不要）。
 *
 * @param {Object} state - 現在のゲーム状態
 * @param {'black'|'white'} color - アクションを実行するプレイヤーの色
 * @returns {Array<Object>} 実行可能なアクションの配列
 */
function listActions(state, color) {
  const actions = [];

  // === 駒を打つアクション ===
  // 持ち駒が残っている場合のみ
  if (state.placed[color] < MAX_PIECES) {
    // 盤面全体を走査し、空きマスをすべて「打つ」手として列挙する
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        // 空きマスに配置可能
        if (state.board[row][col] === null) {
          actions.push({ type: "place", color, to: { row, col } });
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

        actions.push({ type: "move", color, from, to: { row: toRow, col: toCol } });
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
            actions.push({ type: "move", color, from, to: { row: toRow, col: toCol } });
          }

          step += 1;
        }
      }
    }
  }

  return actions;
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
 * ラインスコアの重みについて:
 * 4目の勝ちは「その手で4目が成立した」ときだけなので、盤上に残っている4目は
 * それ自体では勝ちではない。ただし1枚抜いて戻せば成立する2手の勝ち筋であり、
 * 相手はそれを常に防ぎ続けなければならない。よって高い評価のままでよい。
 * （4目の重みを 500〜20000 で振って自己対戦させたところ、1500以上はどれも
 *   互角で、3目(420)に近い500だけが明確に弱かった）
 * 相手の4目は自分より少し高いペナルティにして防御を重視する。
 *
 * 機動力は listActions() を呼ぶと末端評価には重すぎるため、
 * 「自分の駒に隣接する空きマスの数」＋「持ち駒が残っていれば空きマスの数」で近似する。
 * 斜めスライドは数えないが、評価は差分でしか使わないため実用上問題ない。
 *
 * @param {Object} state - 評価するゲーム状態
 * @param {'black'|'white'} color - 評価の基準となるプレイヤーの色
 * @returns {number} 評価スコア（勝利: +WIN_SCORE、敗北: -WIN_SCORE）
 */
function evaluateState(state, color) {
  // 終了状態の場合は勝敗で決定的なスコアを返す
  if (state.status === "finished") {
    // 勝ち・負け・引き分けで決定的なスコアを返す
    if (state.winner === color) {
      return WIN_SCORE;   // 勝利
    }
    if (state.winner) {
      return -WIN_SCORE;  // 敗北
    }
    return 0;             // 引き分け（双方とも合法手なし）
  }

  const board = state.board;
  let emptyCells = 0;
  let myPieces = 0;
  let opponentPieces = 0;

  // 盤面を数値に置き換えながら、駒と空きマスを数える
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const cell = board[CELL_ROW[index]][CELL_COL[index]];
    // 空き・自分の駒・相手の駒で符号を分ける
    if (cell === null) {
      CELL_CODES[index] = 0;
      emptyCells += 1;
    } else if (cell === color) {
      CELL_CODES[index] = 1;
      myPieces += 1;
    } else {
      CELL_CODES[index] = 2;
      opponentPieces += 1;
    }
  }

  // ラインスコアの計算
  // 各列を端から見て、同じ色が続く区間（ライン）ごとに長さに応じた点を足し引きする
  let lineScore = 0;
  for (let k = 0; k < LINES.length; k += 1) {
    const line = LINES[k];
    let runCode = 0;
    let runLength = 0;
    // 列の末尾の1つ先まで回し、最後のラインもそこで締める
    for (let j = 0; j <= line.length; j += 1) {
      let code = 0;
      // 列の末尾の1つ先は空きマスとして扱う
      if (j < line.length) {
        code = CELL_CODES[line[j]];
      }
      // 同じ色の駒が続いていればラインを伸ばす
      if (code !== 0 && code === runCode) {
        runLength += 1;
        continue;
      }
      // ラインが途切れたので、その長さに応じて点を付ける
      if (runCode === 1) {
        lineScore += MY_LINE_SCORES[Math.min(runLength, 5)];
      } else if (runCode === 2) {
        lineScore -= OPPONENT_LINE_SCORES[Math.min(runLength, 5)];
      }
      runCode = code;
      runLength = 1;
    }
  }

  // 機動力（駒の隣にある空きマスの数）を自分と相手で別々に数える
  let myMobility = 0;
  let opponentMobility = 0;
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const code = CELL_CODES[index];
    // 空きマスは動かす駒が無いので数えない
    if (code === 0) {
      continue;
    }
    const neighbors = NEIGHBORS[index];
    let free = 0;
    // 隣接マスのうち空いている数だけ動ける先がある
    for (let j = 0; j < neighbors.length; j += 1) {
      if (CELL_CODES[neighbors[j]] === 0) {
        free += 1;
      }
    }
    // 駒の持ち主の側に加算する
    if (code === 1) {
      myMobility += free;
    } else {
      opponentMobility += free;
    }
  }

  // 持ち駒が残っていれば空きマスすべてが「打つ」手になる
  const opponent = getOpponent(color);
  if ((state.placed[color] || 0) < MAX_PIECES) {
    myMobility += emptyCells;
  }
  if ((state.placed[opponent] || 0) < MAX_PIECES) {
    opponentMobility += emptyCells;
  }

  // 駒数スコア（盤面上の駒の差）
  const pieceScore = (myPieces - opponentPieces) * 5;

  // 機動力スコア（選択肢の多さ）
  const mobilityScore = (myMobility - opponentMobility) * 2;

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

// =============================================================================
// 探索
// =============================================================================

/** トランスポジションテーブルの評価値の種類 */
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;

/**
 * ヒストリー表の1色ぶんの大きさ。
 * 移動は「移動元×移動先」の 25×25 通り、打つ手は移動先の 25 通り。
 */
const HISTORY_SIZE = CELL_COUNT * CELL_COUNT + CELL_COUNT;

/**
 * 手をヒストリー表の添字に変換します。
 * @param {Object} action - 手
 * @returns {number} ヒストリー表の添字
 */
function historyIndex(action) {
  const to = action.to.row * BOARD_SIZE + action.to.col;

  // 白の手は表の後半を使う
  let base = 0;
  if (action.color === "white") {
    base = HISTORY_SIZE;
  }

  // 打つ手には移動元が無いので、移動の領域の後ろを使う
  if (action.type === "place") {
    return base + CELL_COUNT * CELL_COUNT + to;
  }
  const from = action.from.row * BOARD_SIZE + action.from.col;
  return base + from * CELL_COUNT + to;
}

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
 * 置換表とヒストリー表は、反復深化の各深さで使い回す。
 *
 * @param {'black'|'white'} color - CPUプレイヤーの色（最大化する側）
 * @param {number} nodeBudget - 探索するノード数の上限（反復深化の全深さの合計）
 * @returns {{evaluate: Function, nodes: Function}} 探索コンテキスト
 */
function createSearchContext(color, nodeBudget) {
  const table = new Map();

  // ヒストリーヒューリスティック用の表。
  // 枝刈りを起こした手を覚えておき、別の局面でも先に調べる。
  const history = new Float64Array(HISTORY_SIZE * 2);

  let nodes = 0;

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
      return { score: 0, aborted: true };
    }

    // 終局した局面は「早く勝つ・遅く負ける」ほど良いよう、残りの深さで補正する。
    // 補正しないと、勝てる局面で勝ちを先延ばしにしたり、
    // 負けを読み切った局面で最も早く負ける手を選んだりする。
    if (current.status === "finished") {
      let terminal = evaluateState(current, color);
      // 勝ちは早いほど、負けは遅いほど評価を高くする
      if (terminal > 0) {
        terminal += depth;
      } else if (terminal < 0) {
        terminal -= depth;
      }
      return { score: terminal, aborted: false };
    }

    // 読み切った深さでは評価関数の値をそのまま返す
    if (depth === 0) {
      return { score: evaluateState(current, color), aborted: false };
    }

    // 置換表に記録する値の種類を決めるため、呼び出し時の探索窓を残しておく
    const alphaAtEntry = alpha;
    const betaAtEntry = beta;

    const key = serializeState(current);
    const cached = table.get(key);

    // 同じ局面を同じ深さ以上で読んだ結果が残っていれば再利用する。
    // 上限・下限の記録で探索窓を狭めることはしない。狭めた窓で得た値に
    // 確定値の印を付けて保存してしまい、誤った値が広がるため。
    if (cached && cached.depth >= depth) {
      // 確定値なら探索せずにそのまま返せる
      if (cached.flag === TT_EXACT) {
        return { score: cached.score, aborted: false };
      }
      // 下限が既にベータ以上なら、本当の値も窓の外なので打ち切れる
      if (cached.flag === TT_LOWER && cached.score >= beta) {
        return { score: cached.score, aborted: false };
      }
      // 上限が既にアルファ以下なら、本当の値も窓の外なので打ち切れる
      if (cached.flag === TT_UPPER && cached.score <= alpha) {
        return { score: cached.score, aborted: false };
      }
    }

    const actions = listActions(current, current.turn);
    // 合法手が無い局面はそれ以上進められないので評価値を返す
    if (actions.length === 0) {
      return { score: evaluateState(current, color), aborted: false };
    }

    // 置換表に最善手が残っていれば並べ替えのヒントとして使う
    let hint = null;
    if (cached) {
      hint = cached.action;
    }

    // 良さそうな手から調べるほど枝を切れる。
    // 着手先の周囲から見た推定に、これまで枝刈りを起こした実績（ヒストリー）を足す。
    // スコアは1手につき1回だけ計算する（比較関数の中で計算すると O(n log n) 回呼ばれる）。
    const turnColor = current.turn;
    const scores = new Array(actions.length);
    for (let i = 0; i < actions.length; i += 1) {
      // ヒントと同じ手は最優先で調べる
      if (hint && sameAction(actions[i], hint)) {
        scores[i] = Number.POSITIVE_INFINITY;
      } else {
        scores[i] = orderingScore(current, actions[i], turnColor) + history[historyIndex(actions[i])];
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
        // 窓が閉じたら、残りの手を調べても結果は変わらない。
        // 枝刈りを起こした手として、深い局面ほど重くヒストリーに記録する
        if (alpha >= beta) {
          history[historyIndex(action)] += depth * depth;
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
        // 窓が閉じたら、残りの手を調べても結果は変わらない。
        // 枝刈りを起こした手として、深い局面ほど重くヒストリーに記録する
        if (beta <= alpha) {
          history[historyIndex(action)] += depth * depth;
          break;
        }
      }
    }

    // 1手も成立しなかった場合は評価関数の値をそのまま返す
    if (bestAction === null) {
      return { score: evaluateState(current, color), aborted: false };
    }

    // 得られた値が確定値か、探索窓による上限・下限かを記録して再利用できるようにする。
    // ループ中に alpha / beta を書き換えているので、判定には呼び出し時の窓を使う。
    let flag = TT_EXACT;
    if (bestScore <= alphaAtEntry) {
      // どの手もアルファを超えなかった。本当の値はこれ以下
      flag = TT_UPPER;
    } else if (bestScore >= betaAtEntry) {
      // ベータ以上の手が見つかって打ち切った。本当の値はこれ以上
      flag = TT_LOWER;
    }
    table.set(key, { depth, score: bestScore, flag, action: bestAction });

    return { score: bestScore, aborted: false };
  };

  return {
    evaluate,
    nodes: () => nodes,
  };
}

/**
 * 1つの深さについて、根の手を順に評価します。
 *
 * 根の手は1つ浅い深さでの最善手（hint）から調べる。ノード数の予算が途中で尽きた場合は、
 * そこまでに読み切れた手の中の最善手を返す。先頭の hint を読み切れていれば、
 * 返るのは「hint か、同じ深さで hint より良いと分かった手」だけになる。
 *
 * @param {Object} state - 現在のゲーム状態（正規化済み）
 * @param {'black'|'white'} color - CPUプレイヤーの色
 * @param {number} depth - 探索深度
 * @param {Object} context - createSearchContext() で作った探索コンテキスト
 * @param {Object|null} hint - 1つ浅い深さでの最善手
 * @returns {{done: boolean, bestScore: number, bestAction: Object|null}} 結果
 */
function searchRoot(state, color, depth, context, hint) {
  const actions = listRootActions(state, color, hint);
  let bestScore = -Infinity;
  let bestAction = null;

  // 根の手を順に評価する
  for (const action of actions) {
    const result = applyAction(state, action, SEARCH_APPLY);
    // ルール上成立しない手は読み飛ばす
    if (!result.ok) {
      continue;
    }

    // これまでの最善値をアルファに使う（根は最大化なので有効）
    const child = context.evaluate(result.state, depth - 1, bestScore, Infinity);
    // 予算切れ。この深さはここまでで打ち切る
    if (child.aborted) {
      return { done: false, bestScore, bestAction };
    }

    // より良い（または初めての）手が見つかったら最善手を更新する
    if (child.score > bestScore || bestAction === null) {
      bestScore = child.score;
      bestAction = action;
    }
  }

  return { done: true, bestScore, bestAction };
}

/**
 * ミニマックス法（アルファベータ枝刈り）で最善手を探索します。
 *
 * 深さ1から順に読み（反復深化）、ノード数の予算を使い切るか深さの上限に
 * 達した時点の最善手を返す。予算は全深さの合計で、CPU時間はおおむねこれに比例する。
 *
 * @param {Object} rootState - 現在のゲーム状態
 * @param {'black'|'white'} color - CPUプレイヤーの色
 * @param {Object} [options={}] - 探索オプション
 * @param {number} [options.maxDepth=4] - 最大探索深度
 * @param {number} [options.nodeBudget=1200] - 探索するノード数の上限
 * @param {Object} [options.stats] - 探索結果の統計を書き戻すオブジェクト（任意）
 * @returns {Object|null} 最善手（合法手が無い場合はnull）
 */
function searchBestMove(rootState, color, options = {}) {
  const maxDepth = options.maxDepth || 4;
  const nodeBudget = options.nodeBudget || 1200;

  // 以降は正規化済みであることを前提に探索する（SEARCH_APPLY 参照）
  const state = normalizeState(rootState);
  const context = createSearchContext(color, nodeBudget);

  let best = null;
  let bestScore = -Infinity;
  let reachedDepth = 0;

  // 反復深化: 深度1から徐々に深く探索
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const result = searchRoot(state, color, depth, context, best);

    // 読み切れなかった深さでも、見つかった手は前の深さの最善手と同等以上なので採用する
    if (result.bestAction) {
      best = result.bestAction;
      bestScore = result.bestScore;
    }

    // 予算を使い切ったら、これ以上深くは読めない
    if (!result.done) {
      break;
    }
    reachedDepth = depth;

    // 合法手が無い、または勝敗まで読み切れたら、さらに深く読んでも結果は変わらない
    if (!result.bestAction || Math.abs(result.bestScore) >= WIN_SCORE) {
      break;
    }
  }

  // 呼び出し側が統計を求めていれば書き戻す
  if (options.stats) {
    options.stats.nodes = Math.min(context.nodes(), nodeBudget);
    options.stats.depth = reachedDepth;
    options.stats.score = bestScore;
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
 * nodeBudget … 1手の思考で探索するノード数の上限（CPU時間はおおむねこれに比例する）
 *
 * 思考は Durable Object のアラーム1回の中で行う。Durable Object に 10ms の
 * CPU 制限はかからないが、思考中はそのルームのほかのイベントが待たされるので、
 * 1手あたり CPU 数百 ms 程度に収める。本番の CPU は手元の Mac より約3倍遅い
 * （docs/cloudflare-cpu-limit.md）。
 *
 * @type {Object<string, {depth: number, nodeBudget: number}>}
 */
const CPU_LEVELS = {
  easy: { depth: 1, nodeBudget: 1000 },
  normal: { depth: 2, nodeBudget: 4000 },
  hard: { depth: 4, nodeBudget: 8000 },
  strong: { depth: 20, nodeBudget: 30000 },
};

/**
 * 難易度名と環境変数から、実際に使う探索設定を決定します。
 *
 * CPU_MAX_DEPTH / CPU_NODE_BUDGET が設定されている場合は上限として作用し、
 * 難易度ごとの値がそれを超えないよう切り詰めます。
 *
 * @param {string} levelName - 難易度名（easy/normal/hard/strong）
 * @param {Object} [env={}] - Workers の環境変数
 * @returns {{level: string, depth: number, nodeBudget: number}} 探索設定
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
  };
}

export {
  listActions,
  listRootActions,
  evaluateState,
  searchBestMove,
  CPU_LEVELS,
  resolveCpuLevel,
};
