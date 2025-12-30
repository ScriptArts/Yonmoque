import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet } from '../api'
import { useAuth } from '../App'
import { getSocket } from '../socket'

const BOARD_SIZE = 5
const NEUTRAL_POSITIONS = new Set(['0,0', '0,4', '4,0', '4,4', '2,2'])
const BLACK_POSITIONS = new Set([
  '0,2',
  '1,1',
  '1,3',
  '2,0',
  '2,4',
  '3,1',
  '3,3',
  '4,2',
])

const inBounds = (row, col) =>
  row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE

const getCellType = (row, col) => {
  const key = `${row},${col}`
  if (NEUTRAL_POSITIONS.has(key)) return 'neutral'
  if (BLACK_POSITIONS.has(key)) return 'black'
  return 'white'
}

const getValidMoves = (board, color, from) => {
  const moves = new Set()
  const stepDirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]
  for (const [dr, dc] of stepDirs) {
    const row = from.row + dr
    const col = from.col + dc
    if (!inBounds(row, col)) continue
    if (board[row][col] === null) {
      moves.add(`${row},${col}`)
    }
  }

  if (getCellType(from.row, from.col) !== color) {
    return moves
  }

  const diagDirs = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]
  for (const [dr, dc] of diagDirs) {
    let row = from.row + dr
    let col = from.col + dc
    while (inBounds(row, col) && getCellType(row, col) === color) {
      if (board[row][col] !== null) {
        break
      }
      moves.add(`${row},${col}`)
      row += dr
      col += dc
    }
  }
  return moves
}

export default function RoomPage() {
  const { roomId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [room, setRoom] = useState(null)
  const [chat, setChat] = useState([])
  const [game, setGame] = useState(null)
  const [selected, setSelected] = useState(null)
  const [presence, setPresence] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const numericRoomId = useMemo(() => Number(roomId), [roomId])
  const statusLabel = (status) => {
    if (status === 'playing') return '対局中'
    if (status === 'waiting') return '待機中'
    return status
  }
  const seatLabel = (color) => {
    if (color === 'black') return '黒'
    if (color === 'white') return '白'
    return color
  }
  const gameStatusLabel = (status) => {
    if (status === 'playing') return '進行中'
    if (status === 'finished') return '終了'
    if (status === 'waiting') return '待機'
    return status
  }
  const errorMessage = (code) => {
    switch (code) {
      case 'game_not_active':
        return '対局が開始されていません。'
      case 'game_in_progress':
        return '対局中は準備を変更できません。'
      case 'not_your_turn':
        return 'あなたの手番ではありません。'
      case 'no_pieces_left':
        return '持ち駒がありません。'
      case 'occupied':
        return 'そのマスは埋まっています。'
      case 'invalid_move':
        return 'その移動はできません。'
      case 'not_your_piece':
        return '自分の駒ではありません。'
      case 'not_seated':
        return '着席していません。'
      default:
        return '操作に失敗しました。'
    }
  }
  const displayName = (seat) => {
    if (!seat) return '空席'
    return seat.nickname || '名無しプレイヤー'
  }

  useEffect(() => {
    let active = true
    const socket = getSocket()

    const handleRoomState = (payload) => {
      if (!payload || payload.room?.id !== numericRoomId) {
        return
      }
      setRoom(payload.room)
      if (payload.game) {
        setGame(payload.game)
        setSelected(null)
      }
    }

    const handlePresence = (payload) => {
      if (payload && payload.roomId === numericRoomId) {
        setPresence(payload.count)
      }
    }

    const handleChatNew = (payload) => {
      if (payload && payload.room_id === numericRoomId) {
        setChat((prev) => [...prev, payload])
      }
    }

    const handleChatClear = (payload) => {
      if (payload && payload.roomId === numericRoomId) {
        setChat([])
      }
    }

    const handleForfeit = (payload) => {
      if (payload && payload.roomId === numericRoomId) {
        if (payload.winnerColor) {
          setNotice(`${seatLabel(payload.winnerColor)}の勝ち（相手の退出）`)
        } else {
          setNotice('対局が中断されました。')
        }
      }
    }

    const handleGameState = (payload) => {
      if (payload && payload.roomId === numericRoomId) {
        setGame(payload.game)
        setSelected(null)
      }
    }

    socket.on('room:state', handleRoomState)
    socket.on('room:presence', handlePresence)
    socket.on('chat:new', handleChatNew)
    socket.on('chat:cleared', handleChatClear)
    socket.on('room:forfeit', handleForfeit)
    socket.on('game:state', handleGameState)

    socket.emit('room:join', { roomId: numericRoomId }, (response) => {
      if (!active) return
      if (!response || !response.ok) {
        setError('入室に失敗しました。')
        return
      }
      setRoom(response.state.room)
      setChat(response.state.chat)
      setGame(response.state.game)
    })

    apiGet(`/api/rooms/${numericRoomId}`)
      .then((data) => {
        if (active) {
          setRoom(data.room)
          setChat(data.chat)
          setGame(data.game)
        }
      })
      .catch(() => {})

    return () => {
      active = false
      socket.emit('room:leave')
      socket.off('room:state', handleRoomState)
      socket.off('room:presence', handlePresence)
      socket.off('chat:new', handleChatNew)
      socket.off('chat:cleared', handleChatClear)
      socket.off('room:forfeit', handleForfeit)
      socket.off('game:state', handleGameState)
    }
  }, [numericRoomId])

  const handleSeat = (color) => {
    const socket = getSocket()
    socket.emit('seat:take', { roomId: numericRoomId, color }, (response) => {
      if (!response?.ok) {
        setError('席が埋まっています。')
      } else {
        setError('')
      }
    })
  }

  const handleSeatLeave = (color) => {
    const socket = getSocket()
    socket.emit('seat:leave', { roomId: numericRoomId, color }, (response) => {
      if (!response?.ok) {
        setError('席の退出に失敗しました。')
      } else {
        setError('')
      }
    })
  }

  const handleSend = (event) => {
    event.preventDefault()
    if (!message.trim()) {
      return
    }
    const socket = getSocket()
    socket.emit(
      'chat:send',
      { roomId: numericRoomId, message },
      (response) => {
        if (!response?.ok) {
          setError('メッセージの送信に失敗しました。')
        } else {
          setMessage('')
          setError('')
        }
      }
    )
  }

  const mySeat = room?.seats
    ? room.seats.black?.userId === user?.id
      ? 'black'
      : room.seats.white?.userId === user?.id
        ? 'white'
        : null
    : null
  const mySeatText = mySeat ? `着席中（${seatLabel(mySeat)}）` : '観戦中'
  const board = Array.isArray(game?.board)
    ? game.board
    : Array.from({ length: 5 }, () => Array(5).fill(null))
  const placed = game?.placed || { black: 0, white: 0 }
  const ready = game?.ready || { black: false, white: false }
  const myPiecesLeft = mySeat ? Math.max(0, 6 - (placed[mySeat] || 0)) : 0
  const isMyTurn = game?.status === 'playing' && game?.turn === mySeat
  const turnLabel = game?.turn ? seatLabel(game.turn) : '-'
  const moveTargets =
    selected && mySeat && isMyTurn && game?.status === 'playing'
      ? getValidMoves(board, mySeat, selected)
      : new Set()
  const resultLabel = (() => {
    if (!game || game.status !== 'finished') return ''
    if (!game.winner) return '対局終了'
    if (game.result === 'four') return `${seatLabel(game.winner)}の勝ち（4目）`
    if (game.result === 'five') return `${seatLabel(game.winner)}の勝ち（5目のため負け）`
    if (game.result === 'forfeit') {
      return `${seatLabel(game.winner)}の勝ち（相手の退出）`
    }
    return `${seatLabel(game.winner)}の勝ち`
  })()

  const handleReadyToggle = () => {
    if (!mySeat) return
    const socket = getSocket()
    socket.emit(
      'game:ready',
      { roomId: numericRoomId, ready: !ready[mySeat] },
      (response) => {
        if (!response?.ok) {
          setError(errorMessage(response?.error))
        } else {
          setError('')
        }
      }
    )
  }

  const handleCellClick = (row, col) => {
    setNotice('')
    if (!game || game.status !== 'playing') {
      setError('対局が開始されていません。')
      return
    }
    if (!mySeat) {
      setError('観戦中のため操作できません。')
      return
    }
    if (!isMyTurn) {
      setError('あなたの手番ではありません。')
      return
    }
    const cellValue = board[row][col]
    if (selected) {
      if (selected.row === row && selected.col === col) {
        setSelected(null)
        return
      }
      if (cellValue === mySeat) {
        setSelected({ row, col })
        return
      }
      if (cellValue === null) {
        if (!moveTargets.has(`${row},${col}`)) {
          setError('そのマスには移動できません。')
          return
        }
        const socket = getSocket()
        socket.emit(
          'game:move',
          { roomId: numericRoomId, from: selected, to: { row, col } },
          (response) => {
            if (!response?.ok) {
              setError(errorMessage(response?.error))
            } else {
              setError('')
              setSelected(null)
            }
          }
        )
        return
      }
      setError('そのマスには移動できません。')
      return
    }
    if (cellValue === mySeat) {
      setSelected({ row, col })
      setError('')
      return
    }
    if (cellValue === null) {
      if (myPiecesLeft <= 0) {
        setError('持ち駒がありません。')
        return
      }
      const socket = getSocket()
      socket.emit(
        'game:place',
        { roomId: numericRoomId, row, col },
        (response) => {
          if (!response?.ok) {
            setError(errorMessage(response?.error))
          } else {
            setError('')
          }
        }
      )
      return
    }
    setError('そのマスには置けません。')
  }

  return (
    <div className="page room-page">
      <div className="page-header">
        <div>
          <h1>{room ? room.name : 'ルーム'}</h1>
          <p className="muted">観戦: {presence}人</p>
        </div>
        <button className="secondary" onClick={() => navigate('/lobby')}>
          ロビーへ戻る
        </button>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <div className="room-layout">
        <div className="board-panel card">
          <div className="board-header">
            <div className="status-pill">
              状態: {statusLabel(room?.status || 'waiting')}
            </div>
            <div className="status-pill">あなた: {mySeatText}</div>
            <div className="status-pill">
              対局: {gameStatusLabel(game?.status || 'waiting')}
            </div>
            <div className="status-pill">手番: {turnLabel}</div>
            <div className="status-pill">
              準備: 黒 {ready.black ? '●' : '○'} / 白{' '}
              {ready.white ? '●' : '○'}
            </div>
            <div className="status-pill">
              持ち駒 残り: 黒 {Math.max(0, 6 - (placed.black || 0))} / 白{' '}
              {Math.max(0, 6 - (placed.white || 0))}
            </div>
          </div>
          {resultLabel ? <div className="notice">{resultLabel}</div> : null}
          <div className="board-wrapper">
            <img className="board-image" src="/board.svg" alt="盤面" />
            <div className="board-grid">
              {board.map((row, rowIndex) =>
                row.map((cell, colIndex) => {
                  const key = `${rowIndex}-${colIndex}`
                  const isSelected =
                    selected?.row === rowIndex && selected?.col === colIndex
                  const isMoveable = moveTargets.has(
                    `${rowIndex},${colIndex}`
                  )
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`board-cell ${isSelected ? 'selected' : ''} ${
                        isMoveable ? 'moveable' : ''
                      }`}
                      onClick={() => handleCellClick(rowIndex, colIndex)}
                      aria-label={`セル ${rowIndex + 1}-${colIndex + 1}`}
                    >
                      {cell ? <span className={`piece ${cell}`}></span> : null}
                    </button>
                  )
                })
              )}
            </div>
          </div>
          <div className="board-hint muted">
            両者が開始を押すと対局開始。空きマスクリックで配置、駒を選択して移動。
          </div>
        </div>

        <div className="side-panel">
          <div className="seat-panel card">
            <div className="seat-panel-title">着席</div>
            <div className="seat-actions">
              <div className="seat-card">
              <div className="seat-title">黒席</div>
              <div className="seat-owner">{displayName(room?.seats.black)}</div>
              {mySeat === 'black' ? (
                <div className="seat-card-buttons">
                  <button
                    className="secondary"
                    onClick={() => handleSeatLeave('black')}
                  >
                    退席
                  </button>
                  {game?.status !== 'playing' ? (
                    <button className="primary" onClick={handleReadyToggle}>
                      {ready.black ? '準備解除' : '開始'}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="seat-card-buttons">
                  <button
                    className="primary"
                    onClick={() => handleSeat('black')}
                  >
                    着席
                  </button>
                </div>
              )}
            </div>
            <div className="seat-card">
              <div className="seat-title">白席</div>
              <div className="seat-owner">{displayName(room?.seats.white)}</div>
              {mySeat === 'white' ? (
                <div className="seat-card-buttons">
                  <button
                    className="secondary"
                    onClick={() => handleSeatLeave('white')}
                  >
                    退席
                  </button>
                  {game?.status !== 'playing' ? (
                    <button className="primary" onClick={handleReadyToggle}>
                      {ready.white ? '準備解除' : '開始'}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="seat-card-buttons">
                  <button
                    className="primary"
                    onClick={() => handleSeat('white')}
                  >
                    着席
                  </button>
                </div>
              )}
            </div>
            </div>
          </div>

          <div className="chat-panel card">
            <div className="chat-header">
              <div>
                <h2>ルームチャット</h2>
                <p className="muted">最終発言から30分で履歴がクリアされます。</p>
              </div>
            </div>
            <div className="chat-list">
              {chat.length === 0 ? (
                <div className="muted">まだメッセージはありません。</div>
              ) : (
                chat.map((entry) => (
                  <div className="chat-message" key={entry.id}>
                    <div className="chat-meta">
                      <span className="chat-user">
                        {entry.nickname || '名無しプレイヤー'}
                      </span>
                      <span className="chat-time">
                        {new Date(entry.created_at).toLocaleTimeString('ja-JP')}
                      </span>
                    </div>
                    <div className="chat-text">{entry.message}</div>
                  </div>
                ))
              )}
            </div>
            <form className="chat-form" onSubmit={handleSend}>
              <input
                type="text"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="メッセージを入力"
              />
              <button className="primary" type="submit">
                送信
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
