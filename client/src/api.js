export async function apiRequest(path, options = {}) {
  const headers = options.headers || {}
  const hasBody = options.body !== undefined
  const res = await fetch(path, {
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
