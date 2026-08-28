/**
 * @fileoverview ログイン/新規登録ページコンポーネント
 *
 * ユーザー認証を行うページです。
 * - ログインモード: 既存アカウントでログイン
 * - 登録モード: 新規アカウント作成
 *
 * @module LoginPage
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, errorCodeOf } from '../api'
import { useAuth } from '../auth'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@radix-ui/react-label"

/**
 * ログイン/新規登録ページコンポーネント
 * @returns {JSX.Element} ログインページ
 */
export default function LoginPage() {
  const navigate = useNavigate()
  const { setUser } = useAuth()

  // -------------------------------------------------------------------------
  // State定義
  // -------------------------------------------------------------------------

  /** 現在のモード: 'login' または 'register' */
  const [mode, setMode] = useState('login')

  /** ログインID入力値 */
  const [loginId, setLoginId] = useState('')

  /** パスワード入力値 */
  const [password, setPassword] = useState('')

  /** パスワード確認入力値（登録時のみ） */
  const [confirmPassword, setConfirmPassword] = useState('')

  /** ニックネーム入力値（登録時のみ、任意） */
  const [nickname, setNickname] = useState('')

  /** エラーメッセージ */
  const [error, setError] = useState('')

  /** 送信中フラグ */
  const [loading, setLoading] = useState(false)

  /** 登録モードかどうか */
  const isRegister = mode === 'register'

  // -------------------------------------------------------------------------
  // イベントハンドラ
  // -------------------------------------------------------------------------

  /**
   * フォーム送信処理
   * バリデーション → API呼び出し → ロビーへ遷移
   * @param {Event} event - フォーム送信イベント
   */
  const submit = async (event) => {
    event.preventDefault()
    setError('')

    // 登録時のみ、送信前に入力内容を検証する
    if (isRegister) {
      // IDは半角英数字のみ
      if (!/^[a-zA-Z0-9]+$/.test(loginId)) {
        setError('IDは半角英数字のみで入力してください。')
        return
      }
      // IDは3〜20文字
      if (loginId.length < 3 || loginId.length > 20) {
        setError('IDは3〜20文字で入力してください。')
        return
      }
      // パスワードは6文字以上
      if (password.length < 6) {
        setError('パスワードは6文字以上で入力してください。')
        return
      }
      // パスワード確認
      if (password !== confirmPassword) {
        setError('パスワードが一致しません。')
        return
      }
    }

    setLoading(true)

    try {
      // モードに応じて登録APIとログインAPIを呼び分ける
      let data
      if (isRegister) {
        data = await apiPost('/api/auth/register', { loginId, password, nickname })
      } else {
        data = await apiPost('/api/auth/login', { loginId, password })
      }

      // 認証成功: ユーザー情報を保存してロビーへ
      setUser(data.user)
      navigate('/lobby')
    } catch (err) {
      // 登録は原因ごとにメッセージを出し分け、ログインは一律のメッセージにする
      if (isRegister) {
        const code = errorCodeOf(err)
        if (code === 'id_exists') {
          setError('このIDは既に登録されています。')
        } else if (code === 'password_too_short') {
          setError('パスワードは6文字以上で入力してください。')
        } else if (code === 'invalid_id') {
          setError('IDは半角英数字のみで入力してください。')
        } else if (code === 'nickname_too_long') {
          setError('ニックネームは20文字以内で入力してください。')
        } else {
          setError('アカウント作成に失敗しました。')
        }
      } else {
        setError(
          'ログインに失敗しました。IDとパスワードを確認してください。'
        )
      }
    } finally {
      // 成否にかかわらず送信中フラグを解除する
      setLoading(false)
    }
  }

  /**
   * ログイン/登録モードを切り替え
   * エラーとパスワード入力をクリア
   */
  const handleModeToggle = () => {
    // 現在のモードと逆のモードへ切り替える
    if (isRegister) {
      setMode('login')
    } else {
      setMode('register')
    }
    setError('')
    setPassword('')
    setConfirmPassword('')
  }

  // -------------------------------------------------------------------------
  // レンダリング
  // -------------------------------------------------------------------------

  // 見出し・説明文・モード切替リンクの文言をモードに応じて決める
  let formTitle = 'ログイン'
  let formDescription = 'アカウント情報を入力してログインしてください。'
  let modeToggleLabel = 'アカウントをお持ちでない方はこちら'
  if (isRegister) {
    formTitle = 'アカウント作成'
    formDescription = '必要な情報を入力してアカウントを作成してください。'
    modeToggleLabel = 'すでにアカウントをお持ちの方はこちら'
  }

  // 送信ボタンは送信中のみ「処理中...」にし、それ以外は見出しと同じ文言にする
  let submitLabel = formTitle
  if (loading) {
    submitLabel = '処理中...'
  }

  // ニックネーム欄は登録モードのときだけ表示する
  let nicknameField = null
  if (isRegister) {
    nicknameField = (
      <div className="grid gap-1.5">
        <Label htmlFor="nickname" className="text-xs font-medium text-muted-foreground">
          ニックネーム（任意）
        </Label>
        <Input
          id="nickname"
          type="text"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder="名無しプレイヤー"
        />
      </div>
    )
  }

  // パスワード確認欄も登録モードのときだけ表示する
  let confirmPasswordField = null
  if (isRegister) {
    confirmPasswordField = (
      <div className="grid gap-1.5">
        <Label htmlFor="confirmPassword" className="text-xs font-medium text-muted-foreground">
          パスワード（確認）
        </Label>
        <Input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          placeholder="••••••••"
          required
        />
        <p className="text-xs text-muted-foreground">パスワードは6文字以上で入力してください。</p>
      </div>
    )
  }

  // エラーが発生している場合のみ警告を表示する
  let errorView = null
  if (error) {
    errorView = (
      <div className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-medium text-destructive">
        {error}
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl items-center py-6">
      <div className="grid w-full gap-10 lg:grid-cols-[1fr_360px] lg:gap-14">

        {/* ===== 左: ゲームの紹介 =====
            囲いを持たせず地の上に直接置く。囲いがあるのは右のフォームだけにして、
            「操作する場所」を1箇所に絞る。 */}
        <div className="max-w-prose">
          <div className="flex items-center gap-3">
            <img
              className="h-11 w-11 rounded-sm border bg-card object-cover"
              src="/icon.png"
              alt="ヨンモク ロゴ"
            />
            <h1 className="text-3xl font-bold tracking-tight text-secondary">ヨンモク</h1>
          </div>

          <div className="mt-6 space-y-3 border-t pt-6 text-sm leading-relaxed text-foreground/80">
            <p>
              ヨンモクゲームは、1996年に logygames 様が考案した、2人対戦のボードゲームです。
              各プレイヤーは6個の持ち駒を使い、盤上に打ったり移動させたりしながら、
              縦・横・斜めのいずれかの方向に4目を先に並べた方が勝利となります。
              ただし勝ちになるのは駒を動かして4目を成立させたときだけで、駒を打って4目並べても勝ちにはなりません。
              また、5目並べてしまうと負けになる点にも注意が必要です。
            </p>
            <p>
              また、移動させた駒で相手の駒を挟むと、オセロのように相手の駒をひっくり返し、
              自分の色の駒にすることができます。
            </p>
          </div>

          {/* 外部リンク。ボタンで塗らず、文字のリンクとして並べる */}
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <a
              className="underline decoration-border underline-offset-4 hover:decoration-foreground"
              href="https://www.logygames.com/yonmoque/"
              target="_blank"
              rel="noreferrer"
            >
              公式サイト
            </a>
            <a
              className="underline decoration-border underline-offset-4 hover:decoration-foreground"
              href="https://www.logygames.com/yonmoque/j-rule.html"
              target="_blank"
              rel="noreferrer"
            >
              ルール説明
            </a>
          </div>

          {/* クレジット */}
          <div className="mt-8 space-y-1.5 border-t pt-4 text-xs text-muted-foreground">
            <p>
              ※ ヨンモクゲームの原作は{' '}
              <a
                href="https://www.logygames.com/yonmoque/"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-border underline-offset-2 hover:decoration-foreground"
              >
                logygames
              </a>
              {' '}様に帰属します。
            </p>
            <a
              className="inline-flex items-center gap-1.5 hover:text-foreground"
              href="https://www.scriptarts.jp/"
              target="_blank"
              rel="noreferrer"
            >
              <img className="h-4 w-4 rounded-[2px] object-cover" src="/scriptarts-logo.png" alt="" />
              <span>WEB制作: ScriptArts</span>
            </a>
          </div>
        </div>

        {/* ===== 右: ログイン/登録フォーム ===== */}
        <div className="rounded-sm border bg-card p-6 lg:self-start">
          <h2 className="text-base font-bold tracking-tight">
            {formTitle}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {formDescription}
          </p>

          <form onSubmit={submit} className="mt-5 grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="loginId" className="text-xs font-medium text-muted-foreground">
                ID（半角英数字）
              </Label>
              <Input
                id="loginId"
                type="text"
                value={loginId}
                onChange={(event) => setLoginId(event.target.value)}
                placeholder="ScriptArts"
                required
              />
            </div>

            {nicknameField}

            <div className="grid gap-1.5">
              <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">
                パスワード
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {confirmPasswordField}

            {errorView}

            {/* この画面で唯一シアンで塗る要素 */}
            <Button type="submit" disabled={loading} className="mt-1 w-full">
              {submitLabel}
            </Button>
          </form>

          <div className="mt-5 border-t pt-4 text-center">
            <button
              type="button"
              onClick={handleModeToggle}
              className="text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-foreground"
            >
              {modeToggleLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
