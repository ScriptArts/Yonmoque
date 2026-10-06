/**
 * APIのベースURL
 * 本番環境では環境変数から取得、開発環境では空文字（相対パス）
 */
const API_BASE_URL = import.meta.env.VITE_API_URL || ''

export async function apiRequest(path, options = {}) {
  const headers = options.headers || {}
  const hasBody = options.body !== undefined
  const url = `${API_BASE_URL}${path}`

  // リクエストボディがある場合のみ JSON の Content-Type を付与する
  const baseHeaders = {}
  if (hasBody) {
    baseHeaders['Content-Type'] = 'application/json'
  }

  // APIサーバへリクエストを送信する（Cookieを同送するため credentials: include を指定）
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...baseHeaders,
      ...headers,
    },
  })

  // エラーステータスの場合はレスポンス本文からエラー情報を取り出して例外を投げる
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    const error = new Error(payload.error || 'request_failed')
    error.status = res.status
    error.payload = payload
    throw error
  }
  return res.json()
}

export function apiGet(path) {
  return apiRequest(path)
}

/**
 * apiRequest が投げた例外からサーバー側のエラーコードを取り出します。
 * @param {*} err - 例外オブジェクト
 * @returns {string} エラーコード（取得できない場合は空文字）
 */
export function errorCodeOf(err) {
  // 想定外の形の例外はコード無しとして扱い、呼び出し側の既定メッセージを使わせる
  if (!err || !err.payload) {
    return ''
  }
  return err.payload.error || ''
}

export function apiPost(path, data) {
  return apiRequest(path, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  })
}
