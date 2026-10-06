/**
 * @fileoverview WebSocketクライアント
 *
 * Cloudflare Workers では Socket.io サーバーが動かないため、生のWebSocketに
 * 薄いラッパを被せて Socket.io と同じ使い勝手（emit + ack / on / off）を提供する。
 * これにより RoomPage / LobbyPage のイベントハンドラはほぼそのまま使える。
 *
 * プロトコル（worker/src/protocol.js と対）:
 *   送信 { t: 'req', id, event, payload }
 *   受信 { t: 'res', id, payload }   … emit の ack
 *   受信 { t: 'ev',  event, payload } … サーバーからのプッシュ
 *
 * @module socket
 */

/** APIのベースURL（未設定なら同一オリジン） */
const API_BASE_URL = import.meta.env.VITE_API_URL || ''

/** ackを待つ最大時間（ミリ秒） */
const ACK_TIMEOUT_MS = 15000

/** 再接続の待ち時間（ミリ秒）。試行ごとに後ろの値へ進む */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000]

/** ハイバネーション中のDOを起こさずに疎通を保つためのping間隔 */
const PING_INTERVAL_MS = 30000

/**
 * 接続先のWebSocket URLを組み立てます。
 * @param {string} query - クエリ文字列（例: 'roomId=1'）
 * @returns {string} WebSocketのURL
 */
function buildUrl(query) {
  const base = API_BASE_URL || window.location.origin
  const url = new URL('/ws', base)
  // HTTPSで配信されている場合は wss、それ以外は ws で接続する
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else {
    url.protocol = 'ws:'
  }
  url.search = query
  return url.toString()
}

/**
 * Socket.io風のインターフェースを持つWebSocket接続を作ります。
 *
 * @param {string} query - 接続先のクエリ文字列
 * @returns {Object} emit / on / off / close を持つ接続オブジェクト
 */
function createSocket(query) {
  /** @type {WebSocket|null} */
  let ws = null

  /** イベント名 → ハンドラ集合 */
  const listeners = new Map()

  /** 未応答のack待ち（リクエストID → {resolve, timer}） */
  const pending = new Map()

  /** 未接続の間に積まれた送信待ちメッセージ */
  let queue = []

  let nextRequestId = 1
  let reconnectAttempt = 0
  let pingTimer = null
  let closed = false

  /**
   * 登録済みハンドラへイベントを配信します。
   * @param {string} event - イベント名
   * @param {*} payload - ペイロード
   */
  const dispatch = (event, payload) => {
    const handlers = listeners.get(event)
    // 登録済みハンドラが無いイベントは配信対象が無いので何もしない
    if (!handlers) {
      return
    }
    // ハンドラ内で登録解除されても走査が壊れないよう複製してから呼び出す
    for (const handler of [...handlers]) {
      try {
        handler(payload)
      } catch (error) {
        console.error(`socket handler error (${event}):`, error)
      }
    }
  }

  /**
   * 送信待ちのメッセージをすべて送ります。
   */
  const flushQueue = () => {
    // 接続が確立していない間は送信できないので何もしない
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }
    const items = queue
    queue = []
    // 溜まっていた送信待ちメッセージを順番に送る
    for (const item of items) {
      ws.send(item)
    }
  }

  /**
   * 接続を開きます。切断されたら自動で再接続します。
   */
  const connect = () => {
    // close() 済みの接続は再接続しない
    if (closed) {
      return
    }

    // WebSocket接続を開始する
    ws = new WebSocket(buildUrl(query))

    ws.addEventListener('open', () => {
      reconnectAttempt = 0
      flushQueue()
      // ハイバネーション中のDurable Objectを起こさない自動応答pingを使う
      pingTimer = setInterval(() => {
        // 接続中のときだけpingを送る
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send('ping')
        }
      }, PING_INTERVAL_MS)
      dispatch('connect', undefined)
    })

    ws.addEventListener('message', (event) => {
      // pingへの自動応答は処理不要なので読み飛ばす
      if (event.data === 'pong') {
        return
      }

      let message
      try {
        // 受信データをプロトコルのJSONとして解釈する
        message = JSON.parse(event.data)
      } catch {
        return
      }
      // JSONオブジェクトとして解釈できない内容は無視する
      if (!message || typeof message !== 'object') {
        return
      }

      // emitのack応答なら、待機中のリクエストへ結果を返す
      if (message.t === 'res') {
        const entry = pending.get(message.id)
        // 既にタイムアウト済みの場合は待機情報が無いので何もしない
        if (entry) {
          clearTimeout(entry.timer)
          pending.delete(message.id)
          entry.ack(message.payload)
        }
        return
      }

      // サーバーからのプッシュイベントなら登録済みハンドラへ配信する
      if (message.t === 'ev') {
        dispatch(message.event, message.payload)
      }
    })

    ws.addEventListener('close', () => {
      clearInterval(pingTimer)
      pingTimer = null
      ws = null
      dispatch('disconnect', undefined)

      // 明示的に閉じた場合は再接続しない
      if (closed) {
        return
      }

      // 再接続（指数バックオフ）
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]
      reconnectAttempt += 1
      setTimeout(connect, delay)
    })

    ws.addEventListener('error', () => {
      // close も続けて発火するので、ここでは再接続を仕掛けない
    })
  }

  connect()

  return {
    /**
     * サーバーへイベントを送ります。
     * 未接続の間はキューに積み、接続後にまとめて送信します。
     *
     * @param {string} event - イベント名
     * @param {Object} [payload] - ペイロード
     * @param {Function} [ack] - サーバーからの応答を受け取るコールバック
     */
    emit(event, payload, ack) {
      let id = null

      // ackコールバックがある場合のみリクエストIDを採番して応答待ちに登録する
      if (ack) {
        id = nextRequestId++
        // 応答が返らないまま待ち続けないようタイムアウトを仕掛ける
        const timer = setTimeout(() => {
          pending.delete(id)
          ack({ ok: false, error: 'timeout' })
        }, ACK_TIMEOUT_MS)
        pending.set(id, { ack, timer })
      }

      const message = JSON.stringify({ t: 'req', id, event, payload: payload || {} })

      // 接続中なら即送信し、未接続なら接続後に送るためキューへ積む
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      } else {
        queue.push(message)
      }
    },

    /**
     * イベントハンドラを登録します。
     * 'connect' は接続完了時（再接続を含む）、'disconnect' は切断時に発火します。
     * 既に接続済みで 'connect' を登録した場合は即座に一度呼ばれます。
     *
     * @param {string} event - イベント名
     * @param {Function} handler - ハンドラ
     */
    on(event, handler) {
      // 初めて登録するイベント名ならハンドラ集合を用意する
      if (!listeners.has(event)) {
        listeners.set(event, new Set())
      }
      listeners.get(event).add(handler)

      // 接続済みでconnectを登録した場合は取りこぼしを防ぐため一度だけ呼ぶ
      if (event === 'connect' && ws && ws.readyState === WebSocket.OPEN) {
        queueMicrotask(() => {
          const connectHandlers = listeners.get('connect')
          // マイクロタスクが走るまでに解除されていないか確認する
          if (connectHandlers && connectHandlers.has(handler)) {
            handler(undefined)
          }
        })
      }
    },

    /**
     * イベントハンドラを解除します。
     * @param {string} event - イベント名
     * @param {Function} handler - 解除するハンドラ
     */
    off(event, handler) {
      const handlers = listeners.get(event)
      // 未登録のイベント名なら解除対象が無いので何もしない
      if (handlers) {
        handlers.delete(handler)
      }
    },

    /**
     * 接続を閉じます。以後、自動再接続は行いません。
     */
    close() {
      closed = true
      clearInterval(pingTimer)
      pingTimer = null
      queue = []
      // ack待ちのタイムアウトタイマーをすべて止める
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
      }
      pending.clear()
      listeners.clear()
      // 接続が残っていれば閉じる
      if (ws) {
        ws.close()
        ws = null
      }
    },
  }
}

// =============================================================================
// 接続の管理
// =============================================================================

/** ロビー接続（アプリ全体で1本） */
let lobbySocket = null

/** ルーム接続（同時に1部屋） */
let roomSocket = null

/** roomSocket が繋がっているルームID */
let roomSocketId = null

/**
 * ロビー用の接続を取得します。
 * @returns {Object} 接続オブジェクト
 */
export function getLobbySocket() {
  // アプリ全体で1本を共有するため、未接続のときだけ新規作成する
  if (!lobbySocket) {
    lobbySocket = createSocket('lobby=1')
  }
  return lobbySocket
}

/**
 * 指定ルーム用の接続を取得します。
 * 別のルームに繋がっていた場合は張り替えます。
 *
 * @param {number} roomId - ルームID
 * @returns {Object} 接続オブジェクト
 */
export function getRoomSocket(roomId) {
  // 別のルームに繋がっている場合は張り替えるため既存の接続を閉じる
  if (roomSocket && roomSocketId !== roomId) {
    roomSocket.close()
    roomSocket = null
    roomSocketId = null
  }
  // 接続が無ければ指定ルームへ新規接続する
  if (!roomSocket) {
    roomSocket = createSocket(`roomId=${roomId}`)
    roomSocketId = roomId
  }
  return roomSocket
}

/**
 * 現在のルーム接続を閉じます（ルーム画面を離れるとき）。
 */
export function closeRoomSocket() {
  // ルーム接続が残っていれば閉じる
  if (roomSocket) {
    roomSocket.close()
    roomSocket = null
    roomSocketId = null
  }
}

/**
 * すべての接続を閉じます（ログアウト時）。
 */
export function resetSocket() {
  closeRoomSocket()
  // ロビー接続が残っていれば閉じる
  if (lobbySocket) {
    lobbySocket.close()
    lobbySocket = null
  }
}
