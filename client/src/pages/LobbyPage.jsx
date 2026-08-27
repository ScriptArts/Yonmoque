/**
 * @fileoverview ロビーページコンポーネント
 *
 * ルーム一覧を表示し、ルームへの入室やニックネーム設定を行うページです。
 * - ルーム一覧のリアルタイム更新（Socket.io）
 * - ニックネーム設定
 * - ルーム入室
 *
 * @module LobbyPage
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../api'
import { getLobbySocket } from '../socket'
import { cn } from "@/lib/utils"

/**
 * ロビーページコンポーネント
 * @returns {JSX.Element} ロビーページ
 */
export default function LobbyPage() {
  const navigate = useNavigate()

  // -------------------------------------------------------------------------
  // State定義
  // -------------------------------------------------------------------------

  /** ルーム一覧 */
  const [rooms, setRooms] = useState([])

  /** ルーム読み込み中フラグ */
  const [loading, setLoading] = useState(true)

  /** エラーメッセージ */
  const [error, setError] = useState('')


  // -------------------------------------------------------------------------
  // ヘルパー関数
  // -------------------------------------------------------------------------

  /**
   * ルームステータスを日本語ラベルに変換
   * @param {string} status - ステータス文字列
   * @returns {string} 日本語ラベル
   */
  const statusLabel = (status) => {
    if (status === 'playing') return '対局中'
    if (status === 'waiting') return '待機中'
    return status
  }

  /**
   * 座席の表示名を取得
   * @param {Object|null} seat - 座席情報
   * @returns {string} 表示名
   */
  const displayName = (seat) => {
    if (!seat) return '空席'
    return seat.nickname || '名無しプレイヤー'
  }

  // -------------------------------------------------------------------------
  // Effect: ルーム一覧の取得とリアルタイム更新
  // -------------------------------------------------------------------------
  useEffect(() => {
    let active = true

    // 初回ルーム一覧取得
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

    // Socket.ioでルーム更新をリッスン
    const socket = getLobbySocket()
    const handleRooms = (nextRooms) => {
      setRooms(nextRooms)
    }
    socket.on('rooms:update', handleRooms)

    // クリーンアップ
    return () => {
      active = false
      socket.off('rooms:update', handleRooms)
    }
  }, [])

  // -------------------------------------------------------------------------
  // イベントハンドラ
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // レンダリング
  // -------------------------------------------------------------------------

  return (
    <div className="flex-1 space-y-10 pb-4">
      {/* ===== ページヘッダー =====
          罫線1本で見出しを区切る。ルーム数はバッジにせず素の数字で置く。 */}
      <div className="flex items-end justify-between gap-4 border-b pb-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight">ロビー</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            観戦するルームを選ぶか、席に着席してください。
          </p>
        </div>
        <div className="shrink-0 font-mono text-xs text-muted-foreground">
          {rooms.length} ルーム
        </div>
      </div>

      {/* ===== ローディング/エラー表示 ===== */}
      {loading && <div className="py-16 text-center text-sm text-muted-foreground">ルーム読み込み中...</div>}
      {error && <div className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive">{error}</div>}

      {/* ===== ルーム一覧グリッド =====
          カード全体が1つのボタン。上端の色帯で状態を示す:
          シアン = 待機中(入れる) / ピンク = 対局中。
          12枚並ぶので、色は「帯・状態文字・入室チップ」の3点だけに使う。 */}
      <div className="grid gap-px overflow-hidden rounded-sm border bg-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rooms.map((room) => {
          const playing = room.status === 'playing'
          const black = room.seats.black
          const white = room.seats.white
          return (
            <button
              key={room.id}
              type="button"
              onClick={() => navigate(`/room/${room.id}`)}
              className="group flex flex-col bg-card text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
            >
              {/* 状態を示す色帯 */}
              <div className={cn("h-[3px] w-full", playing ? "bg-secondary" : "bg-primary")} />

              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="truncate text-sm font-bold tracking-tight">{room.name}</h3>
                  <span className={cn(
                    "shrink-0 text-[11px] font-semibold",
                    playing ? "text-secondary" : "text-primary"
                  )}>
                    {playing && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-secondary align-middle" />}
                    {statusLabel(room.status)}
                  </span>
                </div>

                {/* 席。空席は輪郭だけにして、埋まり具合を絵で分かるようにする */}
                <dl className="mt-3 space-y-2 border-t pt-3 text-xs">
                  <div className="flex items-center gap-2">
                    <dt className="shrink-0">
                      <span className={cn(
                        "block h-4 w-4 rounded-full border",
                        black ? "border-gray-800 bg-gray-900" : "border-muted-foreground/25 bg-transparent"
                      )} />
                    </dt>
                    <dd className={cn("min-w-0 flex-1 truncate font-mono", black ? "text-foreground" : "text-muted-foreground/70")}>
                      {displayName(black)}
                    </dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <dt className="shrink-0">
                      <span className={cn(
                        "block h-4 w-4 rounded-full border",
                        white ? "border-gray-400 bg-white" : "border-muted-foreground/25 bg-transparent"
                      )} />
                    </dt>
                    <dd className={cn("min-w-0 flex-1 truncate font-mono", white ? "text-foreground" : "text-muted-foreground/70")}>
                      {displayName(white)}
                    </dd>
                  </div>
                </dl>

                {/* 入室。カード全体がボタンなので、ここは見た目だけのチップ */}
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    入室 {room.presence}
                  </span>
                  <span className="inline-flex h-7 items-center rounded-sm border border-primary/60 px-3 text-xs font-semibold text-primary transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground">
                    入室
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>

    </div>
  )
}
