import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet } from '../api'
import { useAuth } from '../auth'
import { getRoomSocket, closeRoomSocket } from '../socket'
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

/**
 * emit の応答が成功しているかを判定します。
 * @param {Object|null} response - サーバーからの応答
 * @returns {boolean} 成功なら true
 */
const isOkResponse = (response) => {
  // 応答自体が無い場合（タイムアウト等）は失敗として扱う
  if (!response) {
    return false
  }
  return Boolean(response.ok)
}

/**
 * emit の応答からエラーコードを取り出します。
 * @param {Object|null} response - サーバーからの応答
 * @returns {string} エラーコード（無い場合は空文字）
 */
const responseErrorCode = (response) => {
  // 応答もエラーコードも無い場合は空文字を返し、既定のメッセージを使わせる
  if (!response || !response.error) {
    return ''
  }
  return response.error
}

const getCellType = (row, col) => {
  const key = `${row},${col}`
  // マスの色は座標で決まっているため、定義済みの集合から判定する
  if (NEUTRAL_POSITIONS.has(key)) {
    return 'neutral'
  }
  if (BLACK_POSITIONS.has(key)) {
    return 'black'
  }
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
  // 8方向の隣接マスのうち、空いているマスへは1歩だけ移動できる
  for (const [dr, dc] of stepDirs) {
    const row = from.row + dr
    const col = from.col + dc
    // 盤外は移動先にならない
    if (!inBounds(row, col)) {
      continue
    }
    // 空きマスのみ移動先として登録する
    if (board[row][col] === null) {
      moves.add(`${row},${col}`)
    }
  }

  // 自分の色のマスに乗っている駒だけが斜めに滑って動ける
  if (getCellType(from.row, from.col) !== color) {
    return moves
  }

  const diagDirs = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]
  // 斜め4方向について、自分の色のマスが続く限り進めるマスを集める
  for (const [dr, dc] of diagDirs) {
    let row = from.row + dr
    let col = from.col + dc
    // 盤内かつ自分の色のマスが続く間だけ進む
    while (inBounds(row, col) && getCellType(row, col) === color) {
      // 駒が置かれているマスにぶつかったらそこで止まる
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
    // 既知のステータスは日本語へ、未知の値はそのまま返す
    if (status === 'playing') {
      return '対局中'
    }
    if (status === 'waiting') {
      return '待機中'
    }
    return status
  }
  const seatLabel = (color) => {
    // 席の色を日本語1文字にする
    if (color === 'black') {
      return '黒'
    }
    if (color === 'white') {
      return '白'
    }
    return color
  }
  const gameStatusLabel = (status) => {
    // 対局の進行状況を日本語へ変換する
    if (status === 'playing') {
      return '進行中'
    }
    if (status === 'finished') {
      return '終了'
    }
    if (status === 'waiting') {
      return '待機'
    }
    return status
  }
  const errorMessage = (code) => {
    // サーバーが返すエラーコードを利用者向けの文言へ変換する
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
    // 座席情報が無い場合は空席として表示する
    if (!seat) {
      return '空席'
    }
    return seat.nickname || '名無しプレイヤー'
  }

  useEffect(() => {
    let active = true
    const socket = getRoomSocket(numericRoomId)

    const handleRoomState = (payload) => {
      // 別ルームの通知や壊れたペイロードは無視する
      if (!payload || !payload.room || payload.room.id !== numericRoomId) {
        return
      }
      setRoom(payload.room)
      // 対局情報が同梱されている場合のみ盤面を更新し、選択を解除する
      if (payload.game) {
        setGame(payload.game)
        setSelected(null)
      }
    }

    const handlePresence = (payload) => {
      // 表示中のルームの入室人数だけ反映する
      if (payload && payload.roomId === numericRoomId) {
        setPresence(payload.count)
      }
    }

    const handleChatNew = (payload) => {
      // 表示中のルームの発言だけ末尾に追加する
      if (payload && payload.room_id === numericRoomId) {
        setChat((prev) => [...prev, payload])
      }
    }

    const handleChatClear = (payload) => {
      // 表示中のルームのクリア通知だけ反映する
      if (payload && payload.roomId === numericRoomId) {
        setChat([])
      }
    }

    const handleForfeit = (payload) => {
      // 表示中のルームの不戦敗通知だけ反映する
      if (payload && payload.roomId === numericRoomId) {
        // 勝者が決まっている場合はその旨を、決まっていない場合は中断として知らせる
        if (payload.winnerColor) {
          setNotice(`${seatLabel(payload.winnerColor)}の勝ち(相手の退出)`)
        } else {
          setNotice('対局が中断されました。')
        }
      }
    }

    const handleGameState = (payload) => {
      // 表示中のルームの盤面更新だけ反映し、選択を解除する
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

    // 接続完了（再接続を含む）のたびに入室し直して状態を同期する。
    // 未接続の間の emit はソケット側でキューされるため取りこぼしはない。
    const handleConnect = () => {
      // 入室してルームの現在状態を受け取る
      socket.emit('room:join', { roomId: numericRoomId }, (response) => {
        // アンマウント後の状態更新を避けるため、有効な間だけ反映する
        if (!active) {
          return
        }
        // 入室に失敗した場合はエラーを表示して以降の反映を行わない
        if (!isOkResponse(response)) {
          setError('入室に失敗しました。')
          return
        }
        setRoom(response.state.room)
        setChat(response.state.chat)
        setGame(response.state.game)
      })
    }
    socket.on('connect', handleConnect)

    // WebSocketの接続完了を待たずに描画できるよう、初期状態はHTTPでも取得する
    apiGet(`/api/rooms/${numericRoomId}`)
      .then((data) => {
        // アンマウント後の状態更新を避けるため、有効な間だけ反映する
        if (active) {
          setRoom(data.room)
          setChat(data.chat)
          setGame(data.game)
        }
      })
      .catch(() => {
        // 失敗しても WebSocket 側の room:join で状態が届くため何もしない
      })

    return () => {
      active = false
      socket.off('connect', handleConnect)
      socket.off('room:state', handleRoomState)
      socket.off('room:presence', handlePresence)
      socket.off('chat:new', handleChatNew)
      socket.off('chat:cleared', handleChatClear)
      socket.off('room:forfeit', handleForfeit)
      socket.off('game:state', handleGameState)
      // 接続を閉じるとサーバー側で離席・不戦敗処理が走る
      closeRoomSocket()
    }
  }, [numericRoomId])

  useEffect(() => {
    // 末尾の目印がまだ描画されていない場合はスクロールできないので何もしない
    if (!chatEndRef.current) {
      return
    }
    // block:'nearest' にしないと親（main）まで巻き込んでスクロールすることがある
    chatEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [chat])

  const handleSeat = (color) => {
    const socket = getRoomSocket(numericRoomId)
    // 指定した色の席へ着席を要求する
    socket.emit('seat:take', { roomId: numericRoomId, color }, (response) => {
      // 失敗した場合だけエラーを表示し、成功したら表示中のエラーを消す
      if (!isOkResponse(response)) {
        setError('席が埋まっています。')
      } else {
        setError('')
      }
    })
  }

  const handleSeatLeave = (color) => {
    const socket = getRoomSocket(numericRoomId)
    // 指定した色の席からの退席を要求する
    socket.emit('seat:leave', { roomId: numericRoomId, color }, (response) => {
      // 失敗した場合だけエラーを表示し、成功したら表示中のエラーを消す
      if (!isOkResponse(response)) {
        setError('席の退出に失敗しました。')
      } else {
        setError('')
      }
    })
  }

  const handleCpuEnable = (color) => {
    setCpuError('')
    const socket = getRoomSocket(numericRoomId)
    // 指定した色の席にCPUを着席させる
    socket.emit(
      'cpu:configure',
      { roomId: numericRoomId, enabled: true, color, level: 'strong' },
      (response) => {
        // 失敗した場合のみ、原因に応じたメッセージを表示する
        if (!isOkResponse(response)) {
          const code = responseErrorCode(response)
          if (code === 'seat_taken') {
            setCpuError('その席は埋まっています。')
          } else if (code === 'game_in_progress') {
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
    const socket = getRoomSocket(numericRoomId)
    // 着席中のCPUを解除する
    socket.emit(
      'cpu:configure',
      { roomId: numericRoomId, enabled: false },
      (response) => {
        // 失敗した場合のみ、原因に応じたメッセージを表示する
        if (!isOkResponse(response)) {
          const code = responseErrorCode(response)
          if (code === 'game_in_progress') {
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
    // 空文字や空白だけの発言は送信しない
    if (!message.trim()) {
      return
    }
    const socket = getRoomSocket(numericRoomId)
    // 入力されたメッセージをルームへ送信する
    socket.emit(
      'chat:send',
      { roomId: numericRoomId, message },
      (response) => {
        // 送信できた場合のみ入力欄を空に戻す
        if (!isOkResponse(response)) {
          setError('メッセージの送信に失敗しました。')
        } else {
          setMessage('')
          setError('')
        }
      }
    )
  }

  // 部屋が未取得の間は席情報を null として扱う
  let blackSeat = null
  let whiteSeat = null
  if (room && room.seats) {
    blackSeat = room.seats.black
    whiteSeat = room.seats.white
  }

  // 自分がどちらの席に着いているかを判定する（着席していなければ null）
  let mySeat = null
  if (user) {
    if (blackSeat && blackSeat.userId === user.id) {
      mySeat = 'black'
    } else if (whiteSeat && whiteSeat.userId === user.id) {
      mySeat = 'white'
    }
  }

  const cpuSeatColor = useMemo(() => {
    // 部屋が未取得ならCPUは着席していない
    if (!room || !room.seats) {
      return null
    }
    // ログインIDが 'cpu' の席をCPUの席とみなす
    if (room.seats.black && room.seats.black.loginId === 'cpu') {
      return 'black'
    }
    if (room.seats.white && room.seats.white.loginId === 'cpu') {
      return 'white'
    }
    return null
  }, [room])

  const opponentColor = useMemo(() => {
    // 自分の席の反対側を相手の色とする（観戦中は相手も決まらない）
    if (mySeat === 'black') {
      return 'white'
    }
    if (mySeat === 'white') {
      return 'black'
    }
    return null
  }, [mySeat])

  const canReleaseCpu = Boolean(cpuSeatColor && mySeat && mySeat !== cpuSeatColor)

  // 着席していれば席の色を、していなければ観戦中と表示する
  let mySeatText = '観戦中'
  if (mySeat) {
    mySeatText = `着席中(${seatLabel(mySeat)})`
  }

  // 盤面が未取得の間は5x5の空盤で描画を成立させる
  let board = Array.from({ length: 5 }, () => Array(5).fill(null))
  if (game && Array.isArray(game.board)) {
    board = game.board
  }

  // 配置済みの駒数は未取得なら0で埋める
  let placed = { black: 0, white: 0 }
  if (game && game.placed) {
    placed = game.placed
  }

  // 準備状態も未取得なら未準備として扱う
  let ready = { black: false, white: false }
  if (game && game.ready) {
    ready = game.ready
  }

  // 自分の持ち駒数（6個から配置済みを引いた数）。観戦中は0とする
  let myPiecesLeft = 0
  if (mySeat) {
    myPiecesLeft = Math.max(0, 6 - (placed[mySeat] || 0))
  }

  // 対局中で手番が自分の席のときだけ操作できる
  let isMyTurn = false
  if (game && game.status === 'playing' && game.turn === mySeat) {
    isMyTurn = true
  }

  // 手番が決まっていない間はハイフンを表示する
  let turnLabel = '-'
  if (game && game.turn) {
    turnLabel = seatLabel(game.turn)
  }

  // 自分の手番で駒を選択しているときだけ移動可能マスを計算する
  let moveTargets = new Set()
  if (selected && mySeat && isMyTurn && game && game.status === 'playing') {
    moveTargets = getValidMoves(board, mySeat, selected)
  }

  /**
   * 終局時に表示する結果の文言を組み立てます。
   * @returns {string} 結果ラベル（対局中は空文字）
   */
  const buildResultLabel = () => {
    // 終局していない間は結果を表示しない
    if (!game || game.status !== 'finished') {
      return ''
    }
    if (game.result === 'draw') {
      return '引き分け(双方とも打つ手がありません)'
    }
    // 勝者が決まっていない終局は汎用の文言にする
    if (!game.winner) {
      return '対局終了'
    }
    if (game.result === 'four') {
      return `${seatLabel(game.winner)}の勝ち(4目)`
    }
    if (game.result === 'five') {
      return `${seatLabel(game.winner)}の勝ち(5目のため負け)`
    }
    if (game.result === 'forfeit') {
      return `${seatLabel(game.winner)}の勝ち(相手の退出)`
    }
    return `${seatLabel(game.winner)}の勝ち`
  }
  const resultLabel = buildResultLabel()

  const handleReadyToggle = () => {
    // 着席していない観戦者は準備状態を変更できない
    if (!mySeat) {
      return
    }
    const socket = getRoomSocket(numericRoomId)
    // 現在の準備状態を反転して送信する
    socket.emit(
      'game:ready',
      { roomId: numericRoomId, ready: !ready[mySeat] },
      (response) => {
        // 失敗した場合はサーバーのエラーコードに対応する文言を表示する
        if (!isOkResponse(response)) {
          setError(errorMessage(responseErrorCode(response)))
        } else {
          setError('')
        }
      }
    )
  }

  const handleCellClick = (row, col) => {
    setNotice('')
    // 対局が始まっていなければ盤面を操作できない
    if (!game || game.status !== 'playing') {
      setError('対局が開始されていません。')
      return
    }
    // 観戦者は盤面を操作できない
    if (!mySeat) {
      setError('観戦中のため操作できません。')
      return
    }
    // 自分の手番でなければ操作できない
    if (!isMyTurn) {
      setError('あなたの手番ではありません。')
      return
    }
    const cellValue = board[row][col]
    // 既に駒を選択している場合は「移動」の操作として扱う
    if (selected) {
      // 選択中のマスをもう一度押したら選択を解除する
      if (selected.row === row && selected.col === col) {
        setSelected(null)
        return
      }
      // 自分の別の駒を押したら選択を そちらへ 移す
      if (cellValue === mySeat) {
        setSelected({ row, col })
        return
      }
      // 空きマスなら移動先として妥当か確認してから移動を要求する
      if (cellValue === null) {
        if (!moveTargets.has(`${row},${col}`)) {
          setError('そのマスには移動できません。')
          return
        }
        const socket = getRoomSocket(numericRoomId)
        // 選択中の駒を押されたマスへ移動させる
        socket.emit(
          'game:move',
          { roomId: numericRoomId, from: selected, to: { row, col } },
          (response) => {
            // 成功したときだけ選択を解除する
            if (!isOkResponse(response)) {
              setError(errorMessage(responseErrorCode(response)))
            } else {
              setError('')
              setSelected(null)
            }
          }
        )
        return
      }
      // 相手の駒があるマスへは移動できない
      setError('そのマスには移動できません。')
      return
    }
    // 未選択の状態で自分の駒を押したら、その駒を選択する
    if (cellValue === mySeat) {
      setSelected({ row, col })
      setError('')
      return
    }
    // 未選択の状態で空きマスを押したら「配置」の操作として扱う
    if (cellValue === null) {
      // 持ち駒が尽きている場合は配置できない
      if (myPiecesLeft <= 0) {
        setError('持ち駒がありません。')
        return
      }
      const socket = getRoomSocket(numericRoomId)
      // 押されたマスへ持ち駒を1つ配置する
      socket.emit(
        'game:place',
        { roomId: numericRoomId, row, col },
        (response) => {
          // 失敗した場合はサーバーのエラーコードに対応する文言を表示する
          if (!isOkResponse(response)) {
            setError(errorMessage(responseErrorCode(response)))
          } else {
            setError('')
          }
        }
      )
      return
    }
    // 相手の駒があるマスには配置できない
    setError('そのマスには置けません。')
  }

  /**
   * 座席パネルに表示する操作ボタンを組み立てます。
   * @param {string} color - 'black' または 'white'
   * @param {Object|null} seat - その席の着席情報
   * @returns {JSX.Element|null} 操作ボタン（表示しない場合は null）
   */
  const buildSeatActions = (color, seat) => {
    // 自分が座っている席では、退席と準備の切り替えを出す
    if (mySeat === color) {
      // 対局中は準備状態を変更できないのでボタンを出さない
      let readyButton = null
      if (!game || game.status !== 'playing') {
        // 準備済みなら解除、未準備なら開始のラベルにする
        let readyLabel = '開始'
        if (ready[color]) {
          readyLabel = '準備解除'
        }
        readyButton = (
          <Button size="sm" className="flex-1" onClick={handleReadyToggle}>
            {readyLabel}
          </Button>
        )
      }
      return (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => handleSeatLeave(color)}>
            退席
          </Button>
          {readyButton}
        </div>
      )
    }

    // 空席の場合、相手側の席ならCPUを座らせ、それ以外なら自分が着席する
    if (!seat) {
      if (opponentColor === color) {
        return (
          <Button size="sm" variant="secondary" className="w-full" onClick={() => handleCpuEnable(color)}>
            CPU
          </Button>
        )
      }
      return (
        <Button size="sm" className="w-full" onClick={() => handleSeat(color)}>
          着席
        </Button>
      )
    }

    // CPUが座っていて、自分が解除できる立場のときだけ解除ボタンを出す
    if (seat.loginId === 'cpu' && canReleaseCpu) {
      return (
        <Button variant="outline" size="sm" className="w-full" onClick={handleCpuDisable}>
          CPU解除
        </Button>
      )
    }

    return null
  }

  // 部屋名は未取得の間、汎用の見出しにする
  let roomName = 'ルーム'
  if (room) {
    roomName = room.name
  }

  // エラー・通知はそれぞれ内容がある場合だけ表示する
  let errorView = null
  if (error) {
    errorView = <div className="shrink-0 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs font-medium text-destructive">{error}</div>
  }
  let noticeView = null
  if (notice) {
    noticeView = <div className="shrink-0 rounded-sm border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary">{notice}</div>
  }
  let cpuErrorView = null
  if (cpuError) {
    cpuErrorView = (
      <div className="shrink-0 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs font-medium text-destructive">
        {cpuError}
      </div>
    )
  }

  // 部屋・対局のステータス表示は、未取得の間は待機として扱う
  let roomStatusText = statusLabel('waiting')
  if (room && room.status) {
    roomStatusText = statusLabel(room.status)
  }
  let gameStatusText = gameStatusLabel('waiting')
  if (game && game.status) {
    gameStatusText = gameStatusLabel(game.status)
  }

  // 打つ手が無くパスになった場合だけ、その旨を表示する
  let passNotice = null
  if (game && game.status === 'playing' && game.passed) {
    passNotice = (
      <div className="inline-flex items-center rounded-sm border border-secondary/40 px-2 py-0.5 font-medium text-secondary">
        {seatLabel(game.passed)}は打つ手がないためパス
      </div>
    )
  }

  // 準備状態は塗り丸（準備済み）と白丸（未準備）で示す
  let blackReadyMark = '○'
  if (ready.black) {
    blackReadyMark = '●'
  }
  let whiteReadyMark = '○'
  if (ready.white) {
    whiteReadyMark = '●'
  }

  // 終局している場合だけ結果を表示する
  let resultView = null
  if (resultLabel) {
    resultView = (
      <div className="w-full shrink-0 rounded-sm border border-primary/30 bg-primary/5 px-3 py-1.5 text-center text-xs font-medium text-primary">
        {resultLabel}
      </div>
    )
  }

  // チャットは、発言が無ければ案内文を、あれば発言一覧を表示する
  let chatView = null
  if (chat.length === 0) {
    chatView = <div className="py-4 text-center text-sm text-muted-foreground">まだメッセージはありません。</div>
  } else {
    // 発言ごとに1件のカードを描画する
    chatView = chat.map((entry) => (
      <div key={entry.id} className="rounded-sm bg-muted/50 p-2">
        <div className="mb-0.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="truncate font-mono font-semibold text-primary">
            {entry.nickname || '名無しプレイヤー'}
          </span>
          <span className="shrink-0 pl-2">{new Date(entry.created_at).toLocaleTimeString('ja-JP')}</span>
        </div>
        <div className="break-words text-sm">{entry.message}</div>
      </div>
    ))
  }

  return (
    <div className="flex flex-col gap-3 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h2 className="truncate text-lg font-bold tracking-tight">{roomName}</h2>
          <p className="shrink-0 text-xs text-muted-foreground">入室: {presence}人</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            対局中に同じタブで遷移すると WebSocket が切れて不戦敗になるため、
            必ず別タブで開く。
          */}
          <Button variant="outline" size="sm" asChild>
            <a
              href="https://www.logygames.com/yonmoque/j-rule.html"
              target="_blank"
              rel="noreferrer"
            >
              ルール
            </a>
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate('/lobby')}>
            ロビーへ戻る
          </Button>
        </div>
      </div>

      {errorView}
      {noticeView}

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="flex flex-col lg:min-h-0 lg:overflow-hidden">
          <CardHeader className="shrink-0 p-3">
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <div className="inline-flex items-center rounded-sm border px-2 py-0.5 font-medium text-muted-foreground">
                状態: {roomStatusText}
              </div>
              <div className="inline-flex items-center rounded-sm border px-2 py-0.5 font-medium text-muted-foreground">
                あなた: {mySeatText}
              </div>
              <div className="inline-flex items-center rounded-sm border px-2 py-0.5 font-medium text-muted-foreground">
                対局: {gameStatusText}
              </div>
              <div className="inline-flex items-center rounded-sm border px-2 py-0.5 font-medium text-muted-foreground">
                手番: {turnLabel}
              </div>
              {passNotice}
              <div className="inline-flex items-center rounded-sm border px-2 py-0.5 font-medium text-muted-foreground">
                準備: 黒 {blackReadyMark} / 白 {whiteReadyMark}
              </div>
              <div className="inline-flex items-center rounded-sm border px-2 py-0.5 font-medium text-muted-foreground">
                持ち駒: 黒 {Math.max(0, 6 - (placed.black || 0))} / 白 {Math.max(0, 6 - (placed.white || 0))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-2 p-3 pt-0 lg:min-h-0 lg:flex-1">
            {resultView}

            {/*
              盤面は「残っている高さ」と「横幅」の狭いほうに合わせて縮む。
              lg 以上では親を container-type:size にして 100cqh を使えるようにし、
              min(100cqw, 100cqh) で常に正方形のまま収める。
              lg 未満（スマホ・縦置き）は従来どおり横幅基準で、ページ側にスクロールを許す。
            */}
            <div className="flex w-full items-center justify-center lg:min-h-0 lg:flex-1 lg:[container-type:size]">
              <div className="relative mx-auto aspect-square w-full max-w-[500px] rounded-sm border bg-white p-3 lg:w-[min(100cqw,100cqh)] lg:max-w-[600px]">
                <img className="block h-full w-full opacity-75" src="/board.svg" alt="盤面" />
                <div className="absolute inset-3 grid grid-cols-5 grid-rows-5 p-[3.2%]">
                  {/* 5x5のマスを行ごとに走査して1マスずつボタンを描画する */}
                  {board.map((row, rowIndex) =>
                    row.map((cell, colIndex) => {
                      const key = `${rowIndex}-${colIndex}`
                      const isMoveable = moveTargets.has(`${rowIndex},${colIndex}`)

                      // 現在選択中のマスかどうかを判定する
                      let isSelected = false
                      if (selected && selected.row === rowIndex && selected.col === colIndex) {
                        isSelected = true
                      }

                      // 選択中は枠を強調し、それ以外はホバー時だけ薄く塗る
                      let highlightClass = "group-hover/cell:bg-primary/10"
                      if (isSelected) {
                        highlightClass = "bg-secondary/15 ring-2 ring-secondary"
                      }

                      // 駒があるマスだけ石を描画し、色に応じて見た目を変える
                      let stone = null
                      if (cell) {
                        let stoneColorClass = "bg-gray-100 border border-gray-300"
                        if (cell === 'black') {
                          stoneColorClass = "bg-gray-900 border border-gray-800"
                        }
                        stone = (
                          <span className={cn(
                            "relative w-[70%] aspect-square rounded-full shadow-[inset_2px_2px_4px_rgba(255,255,255,0.4),inset_-2px_-2px_4px_rgba(0,0,0,0.2),0_2px_4px_rgba(0,0,0,0.2)]",
                            stoneColorClass
                          )} />
                        )
                      }

                      // 移動先の目印。塗り円ではなく小さな点にして盤面を汚さない
                      let moveHint = null
                      if (isMoveable && !cell) {
                        moveHint = <span className="pointer-events-none relative w-[22%] aspect-square rounded-full bg-primary/70" />
                      }

                      return (
                        <button
                          key={key}
                          type="button"
                          className="group/cell relative flex items-center justify-center"
                          onClick={() => handleCellClick(rowIndex, colIndex)}
                          aria-label={`セル ${rowIndex + 1}-${colIndex + 1}`}
                        >
                          {/*
                            ハイライトはボタン自体ではなく駒と同じ 70% の円に描く。
                            ボタンを塗るとマス全体が円になり、盤に描かれた枠から
                            はみ出して見えるため。
                          */}
                          <span
                            className={cn(
                              "pointer-events-none absolute h-[70%] w-[70%] rounded-full transition-colors",
                              highlightClass
                            )}
                          />
                          {stone}
                          {moveHint}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            <p className="shrink-0 text-center text-[11px] text-muted-foreground">
              両者が開始を押すと対局開始。空きマスクリックで配置、駒を選択して移動。
              {' '}
              <a
                href="https://www.logygames.com/yonmoque/j-rule.html"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground"
              >
                ルール
              </a>
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3 lg:min-h-0">
          <Card className="shrink-0">
            <CardHeader className="p-3 pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">着席</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-3 pt-0">
              <div className="space-y-1.5 rounded-sm border p-2.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full bg-gray-900 border border-gray-700" />
                  <span className="text-sm font-medium">黒席</span>
                </div>
                <div className="truncate font-mono text-sm font-semibold">{displayName(blackSeat)}</div>
                {buildSeatActions('black', blackSeat)}
              </div>

              <div className="space-y-1.5 rounded-sm border p-2.5">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full bg-white border border-gray-300" />
                  <span className="text-sm font-medium">白席</span>
                </div>
                <div className="truncate font-mono text-sm font-semibold">{displayName(whiteSeat)}</div>
                {buildSeatActions('white', whiteSeat)}
              </div>
            </CardContent>
          </Card>

          {cpuErrorView}

          <Card className="flex h-[320px] flex-col overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1">
            <CardHeader className="shrink-0 border-b p-3">
              <CardTitle className="text-sm">ルームチャット</CardTitle>
              <p className="text-[11px] text-muted-foreground">最終発言から30分で履歴がクリアされます。</p>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col p-3">
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {chatView}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={handleSend} className="mt-2 flex shrink-0 gap-2 border-t pt-2">
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
