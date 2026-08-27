/**
 * @fileoverview アカウント設定ページコンポーネント
 *
 * ニックネームの変更とパスワードの変更を行うページです。
 * 以前はロビーの下部に置いていましたが、ロビーの目的はルーム選択なので分離しました。
 *
 * @module SettingsPage
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost } from '../api'
import { useAuth } from '../auth'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * アカウント設定ページコンポーネント
 * @returns {JSX.Element} アカウント設定ページ
 */
export default function SettingsPage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuth()

  // -------------------------------------------------------------------------
  // State定義
  // -------------------------------------------------------------------------

  /**
   * ニックネーム入力値の下書き。
   * null の間は user.nickname をそのまま表示するので、
   * user が更新されても effect で同期する必要がない。
   */
  const [nicknameDraft, setNicknameDraft] = useState(null)

  /** 実際に入力欄へ表示する値 */
  const nickname = nicknameDraft ?? (user?.nickname || '')

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
      // 保存後は下書きを破棄し、サーバーから返った値を表示する
      setNicknameDraft(null)
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
    <div className="mx-auto w-full max-w-xl space-y-8 pb-4">
      {/* ===== ページヘッダー ===== */}
      <div className="flex items-end justify-between gap-4 border-b pb-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight">アカウント設定</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            ログイン中: <span className="font-mono">{user?.loginId}</span>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate('/lobby')}>
          ロビーへ戻る
        </Button>
      </div>

      {/* ===== ニックネーム ===== */}
      <section className="rounded-sm border bg-card">
        <div className="border-b border-primary/60 bg-card px-4 py-3">
          <h3 className="text-sm font-bold tracking-tight">ニックネーム</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            対局中や観戦者一覧に表示される名前です。未設定の場合は「名無しプレイヤー」になります。
          </p>
        </div>
        <form onSubmit={handleNicknameSubmit} className="space-y-3 p-4">
          <div className="flex gap-2">
            <Input
              type="text"
              value={nickname}
              maxLength={20}
              onChange={(e) => setNicknameDraft(e.target.value)}
              placeholder="ニックネームを入力"
            />
            <Button type="submit" className="shrink-0">保存</Button>
          </div>
          <p className="text-xs text-muted-foreground">20文字以内で入力してください。</p>
          {nicknameError && <p className="text-xs font-medium text-destructive">{nicknameError}</p>}
          {nicknameNotice && <p className="text-xs font-medium text-primary">{nicknameNotice}</p>}
        </form>
      </section>

      {/* ===== パスワード ===== */}
      <section className="rounded-sm border bg-card">
        <div className="border-b border-secondary/60 bg-card px-4 py-3">
          <h3 className="text-sm font-bold tracking-tight">パスワード変更</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            変更後も他の端末のログイン状態はそのまま保持されます。
          </p>
        </div>
        <form onSubmit={handlePasswordSubmit} className="space-y-3 p-4">
          <div className="grid gap-1.5">
            <label htmlFor="currentPassword" className="text-xs font-medium text-muted-foreground">
              現在のパスワード
            </label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="newPassword" className="text-xs font-medium text-muted-foreground">
              新しいパスワード
            </label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">6文字以上で入力してください。</p>
          </div>
          {passwordError && <p className="text-xs font-medium text-destructive">{passwordError}</p>}
          {passwordNotice && <p className="text-xs font-medium text-primary">{passwordNotice}</p>}
          <div className="flex justify-end pt-1">
            <Button type="submit" variant="secondary">変更する</Button>
          </div>
        </form>
      </section>
    </div>
  )
}
