import { io } from 'socket.io-client'

/**
 * Socket.ioサーバーのURL
 * 本番環境では環境変数から取得、開発環境ではルート
 */
const SOCKET_URL = import.meta.env.VITE_API_URL || '/'

let socket = null

export function getSocket() {
  if (!socket) {
    socket = io(SOCKET_URL, {
      withCredentials: true,
    })
  }
  return socket
}

export function resetSocket() {
  if (socket) {
    socket.disconnect()
    socket = null
  }
}
