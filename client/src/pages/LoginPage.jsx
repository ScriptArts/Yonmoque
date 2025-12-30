import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost } from '../api'
import { useAuth } from '../App'

export default function LoginPage() {
  const navigate = useNavigate()
  const { setUser } = useAuth()
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const isRegister = mode === 'register'

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    if (isRegister) {
      if (password.length < 6) {
        setError('パスワードは6文字以上で入力してください。')
        return
      }
      if (password !== confirmPassword) {
        setError('パスワードが一致しません。')
        return
      }
    }
    setLoading(true)
    try {
      const data = isRegister
        ? await apiPost('/api/auth/register', { email, password, nickname })
        : await apiPost('/api/auth/login', { email, password })
      setUser(data.user)
      navigate('/lobby')
    } catch (err) {
      if (isRegister) {
        const code = err?.payload?.error
        if (code === 'email_exists') {
          setError('このメールアドレスは既に登録されています。')
        } else if (code === 'password_too_short') {
          setError('パスワードは6文字以上で入力してください。')
        } else if (code === 'invalid_email') {
          setError('メールアドレスを確認してください。')
        } else if (code === 'nickname_too_long') {
          setError('ニックネームは20文字以内で入力してください。')
        } else {
          setError('アカウント作成に失敗しました。')
        }
      } else {
        setError(
          'ログインに失敗しました。メールアドレスとパスワードを確認してください。'
        )
      }
    } finally {
      setLoading(false)
    }
  }

  const handleModeToggle = () => {
    setMode(isRegister ? 'login' : 'register')
    setError('')
    setPassword('')
    setConfirmPassword('')
  }

  return (
    <div className="page center">
      <div className="login-layout">
        <div className="card login-hero">
          <div className="login-hero-header">
            <img
              className="login-icon"
              src="/icon.png"
              alt="ヨンモク ロゴ"
            />
            <div className="login-title-stack">
              <div className="brand">ヨンモク</div>
              <a
                className="login-subbrand"
                href="https://www.scriptarts.jp/"
                target="_blank"
                rel="noreferrer"
              >
                <img
                  className="login-subicon"
                  src="/scriptarts-logo.png"
                  alt="ScriptArts ロゴ"
                />
                <span>WEB版制作: ScriptArts</span>
              </a>
            </div>
          </div>
          <div className="login-description">
            <p>
              ヨンモクゲームは、1996年に logygames 様が考案した、2人対戦のボードゲームです。
              各プレイヤーは6個の持ち駒を使い、盤上に打ったり移動させたりしながら、
              縦・横・斜めのいずれかの方向に4目を先に並べた方が勝利となります。
              ただし、5目並べてしまうと負けになる点には注意が必要です。
            </p>
            <p>
              また、移動させた駒で相手の駒を挟むと、オセロのように相手の駒をひっくり返し、
              自分の色の駒にすることができます。
            </p>
            <p>
              シンプルながらも戦略性が高く、とてもスピーディーでスリリングなゲームです。
            </p>
          </div>
          <div className="login-hero-links">
            <a
              className="login-link"
              href="https://www.logygames.com/yonmoque/"
              target="_blank"
              rel="noreferrer"
            >
              ヨンモク公式サイト
            </a>
            <a
              className="login-link"
              href="https://www.logygames.com/yonmoque/j-rule.html"
              target="_blank"
              rel="noreferrer"
            >
              ゲームルール説明ページ
            </a>
          </div>
        </div>

        <div className="card login-card">
          <div className="card-header">
            <div className="login-card-title">
              {isRegister ? 'アカウント作成' : 'ログイン'}
            </div>
          </div>
          <form className="form" onSubmit={submit}>
            <label className="field">
              <span>メールアドレス</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>
            {isRegister ? (
              <label className="field">
                <span>ニックネーム（任意）</span>
                <input
                  type="text"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder="名無しプレイヤー"
                />
              </label>
            ) : null}
            <label className="field">
              <span>パスワード</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
              />
            </label>
            {isRegister ? (
              <label className="field">
                <span>パスワード（確認）</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="••••••••"
                  required
                />
              </label>
            ) : null}
            {isRegister ? (
              <div className="muted">
                パスワードは6文字以上で入力してください。
              </div>
            ) : null}
            {error ? <div className="error">{error}</div> : null}
            <button className="primary" type="submit" disabled={loading}>
              {loading
                ? isRegister
                  ? '作成中...'
                  : 'ログイン中...'
                : isRegister
                  ? 'アカウント作成'
                  : 'ログイン'}
            </button>
            <button className="ghost" type="button" onClick={handleModeToggle}>
              {isRegister ? 'ログインへ戻る' : 'アカウント作成へ'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
