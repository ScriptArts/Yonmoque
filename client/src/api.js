/**
 * APIのベースURL
 * 本番環境では環境変数から取得、開発環境では空文字（相対パス）
 */
const API_BASE_URL = import.meta.env.VITE_API_URL || ''

export async function apiRequest(path, options = {}) {
  const headers = options.headers || {}
  const hasBody = options.body !== undefined
  const url = `${API_BASE_URL}${path}`
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  })

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

export function apiPost(path, data) {
  return apiRequest(path, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  })
}
