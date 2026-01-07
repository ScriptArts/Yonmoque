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
import { apiGet, apiPost } from '../api'
import { getSocket } from '../socket'
import { useAuth } from '../App'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * ロビーページコンポーネント
 * @returns {JSX.Element} ロビーページ
 */
export default function LobbyPage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuth()

  // -------------------------------------------------------------------------
  // State定義
  // -------------------------------------------------------------------------

  /** ルーム一覧 */
  const [rooms, setRooms] = useState([])

  /** ルーム読み込み中フラグ */
  const [loading, setLoading] = useState(true)

  /** エラーメッセージ */
  const [error, setError] = useState('')

  /** ニックネーム入力値 */
  const [nickname, setNickname] = useState(user?.nickname || '')

  /** ニックネーム保存エラー */
  const [nicknameError, setNicknameError] = useState('')

  /** ニックネーム保存完了通知 */
  const [nicknameNotice, setNicknameNotice] = useState('')

  /** 現在のパスワード入力値 */
  const [currentPassword, setCurrentPassword] = useState('')

  /** 新しいパスワード入力値 */
  const [newPassword, setNewPassword] = useState('')

  /** パスワード変更エラー */
  const [passwordError, setPasswordError] = useState('')

  /** パスワード変更完了通知 */
  const [passwordNotice, setPasswordNotice] = useState('')

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
  // Effect: ユーザー情報変更時にニックネーム入力を同期
  // -------------------------------------------------------------------------
  useEffect(() => {
    setNickname(user?.nickname || '')
  }, [user])

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
    const socket = getSocket()
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

  /**
   * ニックネーム保存処理
   * @param {Event} event - フォーム送信イベント
   */
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

  /**
   * パスワード変更処理
   * @param {Event} event - フォーム送信イベント
   */
  const handlePasswordSubmit = async (event) => {
    event.preventDefault()
    setPasswordError('')
    setPasswordNotice('')

    if (newPassword.length < 6) {
      setPasswordError('新しいパスワードは6文字以上で入力してください。')
      return
    }

    try {
      await apiPost('/api/me/password', { currentPassword, newPassword })
      setPasswordNotice('パスワードを変更しました。')
      setCurrentPassword('')
      setNewPassword('')
    } catch (err) {
      if (err?.payload?.error === 'invalid_current_password') {
        setPasswordError('現在のパスワードが正しくありません。')
      } else if (err?.payload?.error === 'password_too_short') {
        setPasswordError('新しいパスワードは6文字以上で入力してください。')
      } else {
        setPasswordError('パスワード変更に失敗しました。')
      }
    }
  }

  // -------------------------------------------------------------------------
  // レンダリング
  // -------------------------------------------------------------------------

  return (
    <div className="flex-1 space-y-8">
      {/* ===== ページヘッダー ===== */}
      <div className="flex items-center justify-between space-y-2">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">ロビー</h2>
          <p className="text-muted-foreground">観戦するルームを選ぶか、席に着席してください。</p>
        </div>
        {/* ルーム数バッジ */}
        <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-foreground bg-secondary/5 border-secondary/20">
          ルーム数: {rooms.length}
        </div>
      </div>

      {/* ===== ニックネーム・パスワード設定 ===== */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* ニックネーム設定カード */}
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">ニックネーム設定</CardTitle>
            <CardDescription>未設定の場合は「名無しプレイヤー」になります。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleNicknameSubmit} className="flex flex-col gap-4">
               <div className="grid w-full items-center gap-1.5">
                 <div className="flex gap-2">
                   <Input
                     type="text"
                     className="bg-background"
                     value={nickname}
                     maxLength={20}
                     onChange={(e) => setNickname(e.target.value)}
                     placeholder="ニックネームを入力"
                   />
                   <Button type="submit">保存</Button>
                 </div>
                 {/* エラー/成功メッセージ */}
                 {nicknameError && <p className="text-sm font-medium text-destructive">{nicknameError}</p>}
                 {nicknameNotice && <p className="text-sm font-medium text-primary">{nicknameNotice}</p>}
               </div>
            </form>
          </CardContent>
        </Card>

        {/* パスワード変更カード */}
        <Card className="border-secondary/20 bg-secondary/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">パスワード変更</CardTitle>
            <CardDescription>パスワードは6文字以上で入力してください。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-3">
               <Input
                 type="password"
                 className="bg-background"
                 value={currentPassword}
                 onChange={(e) => setCurrentPassword(e.target.value)}
                 placeholder="現在のパスワード"
                 autoComplete="current-password"
               />
               <div className="flex gap-2">
                 <Input
                   type="password"
                   className="bg-background"
                   value={newPassword}
                   onChange={(e) => setNewPassword(e.target.value)}
                   placeholder="新しいパスワード"
                   autoComplete="new-password"
                 />
                 <Button type="submit" variant="secondary">変更</Button>
               </div>
               {/* エラー/成功メッセージ */}
               {passwordError && <p className="text-sm font-medium text-destructive">{passwordError}</p>}
               {passwordNotice && <p className="text-sm font-medium text-primary">{passwordNotice}</p>}
            </form>
          </CardContent>
        </Card>
      </div>

      {/* ===== ローディング/エラー表示 ===== */}
      {loading && <div className="text-muted-foreground text-center py-10">ルーム読み込み中...</div>}
      {error && <div className="rounded-md bg-destructive/10 p-4 text-sm font-medium text-destructive">{error}</div>}

      {/* ===== ルーム一覧グリッド ===== */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rooms.map((room) => (
          <Card key={room.id} className="flex flex-col transition-all hover:border-primary/40 hover:shadow-md">
            {/* ルームヘッダー: 名前とステータス */}
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base font-medium truncate pr-2">
                {room.name}
              </CardTitle>
              <div className={cn(
                "text-xs font-bold uppercase px-2 py-0.5 rounded-md",
                room.status === 'playing'
                  ? "bg-secondary/10 text-secondary"
                  : "bg-muted text-muted-foreground"
              )}>
                {statusLabel(room.status)}
              </div>
            </CardHeader>

            {/* ルームコンテンツ: 観戦者数と座席状況 */}
            <CardContent>
               {/* 観戦者数 */}
               <div className="text-xs text-muted-foreground mb-4">観戦: {room.presence}人</div>

               {/* 座席表示 */}
               <div className="space-y-3 text-sm">
                 {/* 黒席 */}
                 <div className="flex justify-between items-center rounded-md bg-muted/40 p-2">
                   <div className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 rounded-full bg-gray-900 border border-gray-700"></span>
                      <span className="font-medium text-xs text-muted-foreground">黒席</span>
                   </div>
                   <span className="font-mono text-xs font-semibold truncate max-w-[100px]">{displayName(room.seats.black)}</span>
                 </div>

                 {/* 白席 */}
                 <div className="flex justify-between items-center rounded-md bg-muted/40 p-2">
                   <div className="flex items-center gap-2">
                      <span className="inline-block h-3 w-3 rounded-full bg-white border border-gray-300"></span>
                      <span className="font-medium text-xs text-muted-foreground">白席</span>
                   </div>
                   <span className="font-mono text-xs font-semibold truncate max-w-[100px]">{displayName(room.seats.white)}</span>
                 </div>
               </div>
            </CardContent>

            {/* 入室ボタン */}
            <CardFooter className="mt-auto pt-4">
              <Button
                className="w-full"
                variant={room.presence > 0 ? "default" : "secondary"}
                onClick={() => navigate(`/room/${room.id}`)}
              >
                入室
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  )
}
