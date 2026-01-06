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
import { apiPost } from '../api'
import { useAuth } from '../App'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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

    // 登録時のバリデーション
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
      // ログインまたは登録APIを呼び出し
      const data = isRegister
        ? await apiPost('/api/auth/register', { loginId, password, nickname })
        : await apiPost('/api/auth/login', { loginId, password })

      // 認証成功: ユーザー情報を保存してロビーへ
      setUser(data.user)
      navigate('/lobby')
    } catch (err) {
      // エラーハンドリング
      if (isRegister) {
        const code = err?.payload?.error
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
      setLoading(false)
    }
  }

  /**
   * ログイン/登録モードを切り替え
   * エラーとパスワード入力をクリア
   */
  const handleModeToggle = () => {
    setMode(isRegister ? 'login' : 'register')
    setError('')
    setPassword('')
    setConfirmPassword('')
  }

  // -------------------------------------------------------------------------
  // レンダリング
  // -------------------------------------------------------------------------

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-4">
      <div className="grid w-full max-w-5xl gap-8 lg:grid-cols-2">

        {/* ===== 左側: ゲーム説明カード ===== */}
        <Card className={`flex flex-col ${!isRegister ? 'justify-between' : 'self-start'} border-secondary/30 bg-secondary/5 shadow-none`}>
          <CardHeader>
            <div className="flex items-center gap-4">
              {/* ゲームアイコン */}
              <img
                className="h-16 w-16 rounded-xl border bg-white object-cover shadow-sm"
                src="/icon.png"
                alt="ヨンモク ロゴ"
              />
              <div>
                <CardTitle className="text-3xl font-bold text-secondary">ヨンモク</CardTitle>
                {/* 制作者リンク */}
                <a
                  className="mt-2 flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-secondary"
                  href="https://www.scriptarts.jp/"
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    className="h-5 w-5 rounded object-cover"
                    src="/scriptarts-logo.png"
                    alt="ScriptArts ロゴ"
                  />
                  <span>WEB制作: ScriptArts</span>
                </a>
              </div>
            </div>
          </CardHeader>

          {/* ゲーム説明文 */}
          <CardContent className="grid gap-4 text-sm leading-relaxed text-foreground/80">
            <div className="rounded-lg bg-white/60 p-4 shadow-sm backdrop-blur-sm">
              <p className="mb-2">
                ヨンモクゲームは、1996年に logygames 様が考案した、2人対戦のボードゲームです。
                各プレイヤーは6個の持ち駒を使い、盤上に打ったり移動させたりしながら、
                縦・横・斜めのいずれかの方向に4目を先に並べた方が勝利となります。
                ただし、5目並べてしまうと負けになる点には注意が必要です。
              </p>
              <p>
                また、移動させた駒で相手の駒を挟むと、オセロのように相手の駒をひっくり返し、
                自分の色の駒にすることができます。
              </p>
            </div>
          </CardContent>

          {/* 外部リンクボタン */}
          <CardFooter className="flex flex-col items-start gap-4">
            <div className="flex flex-wrap gap-3">
               <Button className="bg-secondary text-white hover:bg-secondary/80" asChild>
                <a href="https://www.logygames.com/yonmoque/" target="_blank" rel="noreferrer">
                  公式サイト
                </a>
               </Button>
               <Button className="bg-secondary text-white hover:bg-secondary/80" asChild>
                <a href="https://www.logygames.com/yonmoque/j-rule.html" target="_blank" rel="noreferrer">
                  ルール説明
                </a>
               </Button>
            </div>
            {/* 原作クレジット */}
            <p className="text-xs text-muted-foreground">
              ※ ヨンモクゲームの原作は{' '}
              <a
                href="https://www.logygames.com/yonmoque/"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-secondary"
              >
                logygames
              </a>
              {' '}様に帰属します。
            </p>
          </CardFooter>
        </Card>

        {/* ===== 右側: ログイン/登録フォームカード ===== */}
        <Card className="border-2 border-primary/10 shadow-lg">
          <CardHeader>
            <CardTitle>{isRegister ? 'アカウント作成' : 'ログイン'}</CardTitle>
            <CardDescription>
              {isRegister
                ? '必要な情報を入力してアカウントを作成してください。'
                : 'アカウント情報を入力してログインしてください。'}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={submit} className="grid gap-4">
              {/* ログインID入力 */}
              <div className="grid gap-2">
                <Label htmlFor="loginId" className="text-sm font-medium">ID（半角英数字）</Label>
                <Input
                  id="loginId"
                  type="text"
                  value={loginId}
                  onChange={(event) => setLoginId(event.target.value)}
                  placeholder="ScriptArts"
                  required
                />
              </div>

              {/* ニックネーム入力（登録時のみ） */}
              {isRegister ? (
                <div className="grid gap-2">
                  <Label htmlFor="nickname" className="text-sm font-medium">ニックネーム（任意）</Label>
                  <Input
                    id="nickname"
                    type="text"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                    placeholder="名無しプレイヤー"
                  />
                </div>
              ) : null}

              {/* パスワード入力 */}
              <div className="grid gap-2">
                <Label htmlFor="password" className="text-sm font-medium">パスワード</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="••••••••"
                  required
                />
              </div>

              {/* パスワード確認入力（登録時のみ） */}
              {isRegister ? (
                <div className="grid gap-2">
                  <Label htmlFor="confirmPassword" className="text-sm font-medium">パスワード（確認）</Label>
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
              ) : null}

              {/* エラーメッセージ表示 */}
              {error ? (
                <div className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive">
                  {error}
                </div>
              ) : null}

              {/* 送信ボタン */}
              <Button type="submit" disabled={loading} className="w-full">
                {loading
                  ? '処理中...'
                  : isRegister
                    ? 'アカウント作成'
                    : 'ログイン'}
              </Button>
            </form>
          </CardContent>

          {/* モード切り替えリンク */}
          <CardFooter className="flex justify-center border-t p-6">
            <Button variant="link" onClick={handleModeToggle}>
              {isRegister ? 'すでにアカウントをお持ちの方はこちら' : 'アカウントをお持ちでない方はこちら'}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
