import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../api'
import { getSocket } from '../socket'
import { useAuth } from '../App'

export default function LobbyPage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuth()
  const [rooms, setRooms] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nickname, setNickname] = useState(user?.nickname || '')
  const [nicknameError, setNicknameError] = useState('')
  const [nicknameNotice, setNicknameNotice] = useState('')

  const statusLabel = (status) => {
    if (status === 'playing') return '対局中'
    if (status === 'waiting') return '待機中'
    return status
  }

  useEffect(() => {
    setNickname(user?.nickname || '')
  }, [user])

  useEffect(() => {
    let active = true
    apiGet('/api/rooms')
      .then((data) => {
        if (active) {
          setRooms(data.rooms)
        }
      })
      .catch(() => {
        if (active) {
          setError('ルームの取得に失敗しました。')
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    const socket = getSocket()
    const handleRooms = (nextRooms) => {
      setRooms(nextRooms)
    }
    socket.on('rooms:update', handleRooms)

    return () => {
      active = false
      socket.off('rooms:update', handleRooms)
    }
  }, [])

  const handleNicknameSubmit = async (event) => {
    event.preventDefault()
    setNicknameError('')
    setNicknameNotice('')
    try {
      const data = await apiPost('/api/me/nickname', { nickname })
      setUser(data.user)
      setNicknameNotice('保存しました。')
    } catch (err) {
      if (err?.payload?.error === 'nickname_too_long') {
        setNicknameError('ニックネームは20文字以内で入力してください。')
      } else {
        setNicknameError('保存に失敗しました。')
      }
    }
  }

  const displayName = (seat) => {
    if (!seat) return '空席'
    return seat.nickname || '名無しプレイヤー'
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>ロビー</h1>
          <p className="muted">観戦するルームを選ぶか、席に着席してください。</p>
        </div>
        <div className="badge">ルーム数: {rooms.length}</div>
      </div>

      <form className="card nickname-card" onSubmit={handleNicknameSubmit}>
        <div className="nickname-meta">
          <div className="nickname-title">ニックネーム設定</div>
          <div className="muted">未設定の場合は「名無しプレイヤー」になります。</div>
        </div>
        <div className="nickname-fields">
          <input
            type="text"
            value={nickname}
            maxLength={20}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="ニックネームを入力"
          />
          <button className="primary" type="submit">
            保存
          </button>
        </div>
        {nicknameError ? <div className="error">{nicknameError}</div> : null}
        {nicknameNotice ? <div className="notice">{nicknameNotice}</div> : null}
      </form>

      {loading ? <div className="card">ルーム読み込み中...</div> : null}
      {error ? <div className="error">{error}</div> : null}

      <div className="room-grid">
        {rooms.map((room) => (
          <div className="card room-card" key={room.id}>
            <div className="room-title">
              <div>
                <div className="room-name">{room.name}</div>
                <div className={`room-status ${room.status}`}>{statusLabel(room.status)}</div>
              </div>
              <div className="presence">観戦: {room.presence}人</div>
            </div>
            <div className="room-seats">
              <div>
                <span className="seat-label">黒席</span>
                <span className="seat-value">
                  {displayName(room.seats.black)}
                </span>
              </div>
              <div>
                <span className="seat-label">白席</span>
                <span className="seat-value">
                  {displayName(room.seats.white)}
                </span>
              </div>
            </div>
            <button className="primary" onClick={() => navigate(`/room/${room.id}`)}>
              入室
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
