/**
 * @fileoverview CPU制限の確認用プローブ
 *
 * 本番と同じ CPU 対戦の探索（ai.js）を、指定したノード数だけ
 *   - Worker の fetch
 *   - Durable Object の fetch
 *   - Durable Object の alarm
 * の3か所で実行し、それぞれ最後まで走り切れるかを確かめる。
 *
 * Workers では同期処理の途中で Date.now() / performance.now() が進まないため、
 * CPU 時間はコード内では測れない。実際の CPU 時間は `wrangler tail --format json`
 * の cpuTime か、ダッシュボードの Workers Logs で確認する。
 *
 * 目安（2026-10-06 時点の ai.js）: 手元の Mac では 500,000ノード ≒ 1秒、
 * 本番の Durable Object では 500,000ノード ≒ 3秒。
 *
 * 手順と過去の結果は docs/cloudflare-cpu-limit.md を参照。
 */

import { DurableObject } from "cloudflare:workers";
// 本番と同じ探索コードをそのまま使う（コピーすると本番とずれるため）
import { searchBestMove } from "../../../worker/src/ai.js";

/** 探索に使う固定の中盤局面（毎回同じ量の計算になるよう固定する） */
const POSITION = {
  board: [
    [null, "white", null, null, null],
    [null, null, "white", null, null],
    [null, null, null, "white", null],
    [null, null, null, "black", null],
    [null, "black", "black", "black", "white"],
  ],
  placed: { black: 4, white: 4 },
  turn: "black",
  status: "playing",
};

/** 一度に指定できるノード数の上限（誤って巨大な値を投げないため） */
const MAX_NODES = 5000000;

/**
 * クエリからノード数を読み取ります。
 * @param {URL} url - リクエストURL
 * @returns {number} ノード数
 */
function readNodes(url) {
  const raw = Number(url.searchParams.get("nodes"));
  // 数値でなければ既定の1,000ノードにする
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1000;
  }
  return Math.min(Math.floor(raw), MAX_NODES);
}

/**
 * 指定ノード数だけ探索して、実際に探索したノード数を返します。
 * @param {number} nodes - 探索するノード数
 * @returns {{nodes: number, depth: number}} 探索結果
 */
function burn(nodes) {
  const stats = {};
  // 深さの上限を大きく取り、ノード予算を使い切るまで読ませる
  searchBestMove(POSITION, "black", { maxDepth: 30, nodeBudget: nodes, stats });
  return { nodes: stats.nodes, depth: stats.depth };
}

export class CpuProbe extends DurableObject {
  /**
   * Durable Object の fetch。/do は即座に探索、/alarm はアラームを仕掛ける。
   * @param {Request} request - リクエスト
   * @returns {Promise<Response>} レスポンス
   */
  async fetch(request) {
    const url = new URL(request.url);
    const nodes = readNodes(url);

    // fetch の中で直接探索する
    if (url.pathname === "/do") {
      const result = burn(nodes);
      return Response.json({ where: "durable-object-fetch", requested: nodes, ...result });
    }

    // アラームの中で探索させる。結果はストレージに残し /result で読む
    if (url.pathname === "/alarm") {
      const id = crypto.randomUUID();
      await this.ctx.storage.put("job", { id, nodes, status: "pending", attempts: 0 });
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ where: "durable-object-alarm", id, requested: nodes });
    }

    // アラームの結果を返す
    if (url.pathname === "/result") {
      const job = await this.ctx.storage.get("job");
      return Response.json(job || { status: "none" });
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * アラームハンドラ。ここで探索を走らせ、走り切れたら結果を保存する。
   * CPU 制限で打ち切られた場合は保存まで到達せず、status は pending のまま残る
   * （アラームは自動で再試行されるので attempts が増えていく）。
   * @returns {Promise<void>}
   */
  async alarm() {
    const job = await this.ctx.storage.get("job");
    // ジョブが無ければ何もしない
    if (!job) {
      return;
    }
    // 再試行の回数を先に記録しておく（打ち切られても回数だけは残る）
    job.attempts += 1;
    await this.ctx.storage.put("job", job);

    const result = burn(job.nodes);
    await this.ctx.storage.put("job", { ...job, status: "done", searched: result.nodes, depth: result.depth });
  }
}

export default {
  /**
   * Worker の入口。/worker はここで探索し、それ以外は Durable Object に回す。
   * @param {Request} request - リクエスト
   * @param {Object} env - バインディング
   * @returns {Promise<Response>} レスポンス
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Worker 自身の fetch の中で探索する（無料プランなら10ms制限の対象）
    if (url.pathname === "/worker") {
      const nodes = readNodes(url);
      const result = burn(nodes);
      return Response.json({ where: "worker-fetch", requested: nodes, ...result });
    }

    // それ以外は Durable Object に転送する
    const stub = env.PROBE.get(env.PROBE.idFromName("probe"));
    return stub.fetch(request);
  },
};
