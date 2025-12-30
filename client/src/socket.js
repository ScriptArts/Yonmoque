import { io } from 'socket.io-client'

let socket = null

export function getSocket() {
  if (!socket) {
    socket = io('/', {
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
