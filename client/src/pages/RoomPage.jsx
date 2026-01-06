import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet } from '../api'
import { useAuth } from '../App'
import { getSocket } from '../socket'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

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
  const [cpuError, setCpuError] = useState('')
  const [notice, setNotice] = useState('')
  const chatEndRef = useRef(null)

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
          setNotice(`${seatLabel(payload.winnerColor)}の勝ち(相手の退出)`)
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

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat])

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

  const handleCpuEnable = (color) => {
    setCpuError('')
    const socket = getSocket()
    socket.emit(
      'cpu:configure',
      { roomId: numericRoomId, enabled: true, color, level: 'strong' },
      (response) => {
        if (!response?.ok) {
          if (response?.error === 'seat_taken') {
            setCpuError('その席は埋まっています。')
          } else if (response?.error === 'game_in_progress') {
            setCpuError('対局中はCPU設定を変更できません。')
          } else {
            setCpuError('CPU対戦の設定に失敗しました。')
          }
        }
      }
    )
  }

  const handleCpuDisable = () => {
    setCpuError('')
    const socket = getSocket()
    socket.emit(
      'cpu:configure',
      { roomId: numericRoomId, enabled: false },
      (response) => {
        if (!response?.ok) {
          if (response?.error === 'game_in_progress') {
            setCpuError('対局中はCPU設定を変更できません。')
          } else {
            setCpuError('CPU対戦の解除に失敗しました。')
          }
        }
      }
    )
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
  const cpuSeatColor = useMemo(() => {
    if (room?.seats?.black?.loginId === 'cpu') return 'black'
    if (room?.seats?.white?.loginId === 'cpu') return 'white'
    return null
  }, [room])
  const opponentColor = useMemo(() => {
    if (mySeat === 'black') return 'white'
    if (mySeat === 'white') return 'black'
    return null
  }, [mySeat])
  const canReleaseCpu = Boolean(cpuSeatColor && mySeat && mySeat !== cpuSeatColor)
  const mySeatText = mySeat ? `着席中(${seatLabel(mySeat)})` : '観戦中'
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
    if (game.result === 'four') return `${seatLabel(game.winner)}の勝ち(4目)`
    if (game.result === 'five') return `${seatLabel(game.winner)}の勝ち(5目のため負け)`
    if (game.result === 'forfeit') {
      return `${seatLabel(game.winner)}の勝ち(相手の退出)`
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
    <div className="flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">{room ? room.name : 'ルーム'}</h2>
          <p className="text-sm text-muted-foreground">観戦: {presence}人</p>
        </div>
        <Button variant="outline" onClick={() => navigate('/lobby')}>
          ロビーへ戻る
        </Button>
      </div>

      {error && <div className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive">{error}</div>}
      {notice && <div className="rounded-md bg-primary/10 p-3 text-sm font-medium text-primary border border-primary/20">{notice}</div>}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card className="flex flex-col">
          <CardHeader className="pb-4">
            <div className="flex flex-wrap gap-2 text-xs">
              <div className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-medium">
                状態: {statusLabel(room?.status || 'waiting')}
              </div>
              <div className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-medium">
                あなた: {mySeatText}
              </div>
              <div className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-medium">
                対局: {gameStatusLabel(game?.status || 'waiting')}
              </div>
              <div className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-medium">
                手番: {turnLabel}
              </div>
              <div className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-medium">
                準備: 黒 {ready.black ? '●' : '○'} / 白 {ready.white ? '●' : '○'}
              </div>
              <div className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-medium">
                持ち駒: 黒 {Math.max(0, 6 - (placed.black || 0))} / 白 {Math.max(0, 6 - (placed.white || 0))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4">
            {resultLabel && <div className="w-full rounded-md bg-primary/10 p-3 text-center text-sm font-medium text-primary border border-primary/20">{resultLabel}</div>}
            
            <div className="relative w-full max-w-[500px] rounded-2xl border-4 border-border bg-white p-4 shadow-lg">
              <img className="w-full h-auto block opacity-60" src="/board.svg" alt="盤面" />
              <div className="absolute inset-4 grid grid-cols-5 grid-rows-5 p-[3.2%]">
                {board.map((row, rowIndex) =>
                  row.map((cell, colIndex) => {
                    const key = `${rowIndex}-${colIndex}`
                    const isSelected = selected?.row === rowIndex && selected?.col === colIndex
                    const isMoveable = moveTargets.has(`${rowIndex},${colIndex}`)
                    return (
                      <button
                        key={key}
                        type="button"
                        className={cn(
                          "flex items-center justify-center rounded-full transition-colors relative",
                          "hover:bg-primary/10",
                          isSelected && "shadow-[0_0_0_2px] shadow-secondary bg-secondary/10",
                          isMoveable && "bg-primary/15"
                        )}
                        onClick={() => handleCellClick(rowIndex, colIndex)}
                        aria-label={`セル ${rowIndex + 1}-${colIndex + 1}`}
                      >
                        {cell && (
                          <span className={cn(
                            "w-[70%] aspect-square rounded-full shadow-[inset_2px_2px_4px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.2),0_2px_4px_rgba(0,0,0,0.2)]",
                            cell === 'black' ? "bg-gray-900 border border-gray-800" : "bg-gray-100 border border-gray-300"
                          )} />
                        )}
                        {isMoveable && !cell && (
                          <span className="w-3 h-3 rounded-full bg-primary opacity-50" />
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </div>
            
            <p className="text-xs text-center text-muted-foreground bg-muted rounded-md px-3 py-2">
              両者が開始を押すと対局開始。空きマスクリックで配置、駒を選択して移動。
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">着席</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-lg border bg-card p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full bg-gray-900 border border-gray-700" />
                    <span className="text-sm font-medium text-primary">黒席</span>
                  </div>
                </div>
                <div className="font-mono text-sm font-semibold">{displayName(room?.seats.black)}</div>
                {mySeat === 'black' ? (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => handleSeatLeave('black')}>
                      退席
                    </Button>
                    {game?.status !== 'playing' && (
                      <Button size="sm" className="flex-1" onClick={handleReadyToggle}>
                        {ready.black ? '準備解除' : '開始'}
                      </Button>
                    )}
                  </div>
                ) : !room?.seats.black ? (
                  opponentColor === 'black' ? (
                    <Button size="sm" variant="secondary" className="w-full" onClick={() => handleCpuEnable('black')}>
                      CPU
                    </Button>
                  ) : (
                    <Button size="sm" className="w-full" onClick={() => handleSeat('black')}>
                      着席
                    </Button>
                  )
                ) : room?.seats.black?.loginId === 'cpu' && canReleaseCpu ? (
                  <Button variant="outline" size="sm" className="w-full" onClick={handleCpuDisable}>
                    CPU解除
                  </Button>
                ) : null}
              </div>

              <div className="rounded-lg border bg-card p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-3 w-3 rounded-full bg-white border border-gray-300" />
                    <span className="text-sm font-medium text-primary">白席</span>
                  </div>
                </div>
                <div className="font-mono text-sm font-semibold">{displayName(room?.seats.white)}</div>
                {mySeat === 'white' ? (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => handleSeatLeave('white')}>
                      退席
                    </Button>
                    {game?.status !== 'playing' && (
                      <Button size="sm" className="flex-1" onClick={handleReadyToggle}>
                        {ready.white ? '準備解除' : '開始'}
                      </Button>
                    )}
                  </div>
                ) : !room?.seats.white ? (
                  opponentColor === 'white' ? (
                    <Button size="sm" variant="secondary" className="w-full" onClick={() => handleCpuEnable('white')}>
                      CPU
                    </Button>
                  ) : (
                    <Button size="sm" className="w-full" onClick={() => handleSeat('white')}>
                      着席
                    </Button>
                  )
                ) : room?.seats.white?.loginId === 'cpu' && canReleaseCpu ? (
                  <Button variant="outline" size="sm" className="w-full" onClick={handleCpuDisable}>
                    CPU解除
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {cpuError && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive">
              {cpuError}
            </div>
          )}

          <Card className="flex flex-col h-[400px]">
            <CardHeader className="pb-3 border-b">
              <CardTitle className="text-base">ルームチャット</CardTitle>
              <p className="text-xs text-muted-foreground">最終発言から30分で履歴がクリアされます。</p>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col p-4 min-h-0">
              <div className="flex-1 overflow-y-auto space-y-3 pr-2 min-h-0">
                {chat.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-4">まだメッセージはありません。</div>
                ) : (
                  chat.map((entry) => (
                    <div key={entry.id} className="rounded-lg bg-muted/40 p-2.5">
                      <div className="flex justify-between items-center mb-1 text-xs text-muted-foreground">
                        <span className="font-mono font-semibold text-primary">
                          {entry.nickname || '名無しプレイヤー'}
                        </span>
                        <span>{new Date(entry.created_at).toLocaleTimeString('ja-JP')}</span>
                      </div>
                      <div className="text-sm">{entry.message}</div>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={handleSend} className="flex gap-2 mt-3 pt-3 border-t">
                <Input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="メッセージを入力"
                  className="flex-1"
                />
                <Button type="submit" size="sm">
                  送信
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
