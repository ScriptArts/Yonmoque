/**
 * @fileoverview WebSocketメッセージ形式の定義
 *
 * Socket.io の代わりに使う最小限のプロトコル。
 * イベント名とペイロードは Socket.io 版とそのまま同じものを使うため、
 * 画面側（RoomPage / LobbyPage）のハンドラは変更せずに済む。
 *
 *   クライアント → サーバー（ack要求）  { t: 'req', id, event, payload }
 *   サーバー → クライアント（ack応答）  { t: 'res', id, payload }
 *   サーバー → クライアント（プッシュ） { t: 'ev',  event, payload }
 *
 * @module protocol
 */

/** ハイバネーションを妨げずに疎通確認するためのping文字列 */
const PING = "ping";

/** pingに対する自動応答 */
const PONG = "pong";

/**
 * サーバーからのプッシュイベントを組み立てます。
 * @param {string} event - イベント名（例: 'game:state'）
 * @param {*} payload - ペイロード
 * @returns {string} 送信用のJSON文字列
 */
function encodeEvent(event, payload) {
  return JSON.stringify({ t: "ev", event, payload });
}

/**
 * ack応答を組み立てます。
 * @param {number|string} id - 対応するリクエストID
 * @param {*} payload - 応答内容
 * @returns {string} 送信用のJSON文字列
 */
function encodeResponse(id, payload) {
  return JSON.stringify({ t: "res", id, payload });
}

/**
 * 受信した文字列をメッセージオブジェクトに変換します。
 * @param {string|ArrayBuffer} raw - 受信データ
 * @returns {Object|null} パースできたメッセージ、失敗時はnull
 */
function decodeMessage(raw) {
  // バイナリフレームはこのプロトコルでは使わないので受け付けない
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    // メッセージはオブジェクトである必要があるため、それ以外はnullにする
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export { PING, PONG, encodeEvent, encodeResponse, decodeMessage };
