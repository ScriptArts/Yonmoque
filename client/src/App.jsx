import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { apiGet, apiPost } from './api'
import { resetSocket } from './socket'
import { AuthContext, useAuth } from './auth'
import LoginPage from './pages/LoginPage.jsx'
import LobbyPage from './pages/LobbyPage.jsx'
import RoomPage from './pages/RoomPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import { Button } from "@/components/ui/button"
import { Link } from 'react-router-dom'

function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">読み込み中...</div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return children
}

export default function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    apiGet('/api/me')
      .then((data) => {
        if (active) {
          setUser(data.user)
        }
      })
      .catch(() => {
        if (active) {
          setUser(null)
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  const authValue = useMemo(
    () => ({
      user,
      setUser,
      loading,
      logout: async () => {
        await apiPost('/api/auth/logout')
        resetSocket()
        setUser(null)
      },
    }),
    [user, loading]
  )

  return (
    <AuthContext.Provider value={authValue}>
      <div className="flex h-dvh flex-col overflow-hidden font-sans">
        {user ? (
          <header className="w-full shrink-0 border-b bg-card">
            <div className="container mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-8">
              <div className="flex items-center gap-2.5">
                <img className="h-7 w-7 rounded-sm border" src="/icon.png" alt="ヨンモク アイコン" />
                <span className="text-base font-bold tracking-tight text-secondary">ヨンモク</span>
              </div>
              <div className="flex items-center gap-4">
                {/* 名前をそのままアカウント設定への入口にする */}
                <Link
                  to="/settings"
                  className="hidden font-mono text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground hover:decoration-foreground md:inline"
                >
                  {user.nickname || '名無しプレイヤー'}
                </Link>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/settings">設定</Link>
                </Button>
                <Button variant="outline" size="sm" onClick={authValue.logout}>
                  ログアウト
                </Button>
              </div>
            </div>
          </header>
        ) : null}
        <main className="container mx-auto min-h-0 w-full max-w-6xl flex-1 overflow-auto p-4 md:px-8 md:py-5">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/lobby"
              element={
                <RequireAuth>
                  <LobbyPage />
                </RequireAuth>
              }
            />
            <Route
              path="/room/:roomId"
              element={
                <RequireAuth>
                  <RoomPage />
                </RequireAuth>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <SettingsPage />
                </RequireAuth>
              }
            />
            <Route path="/" element={<Navigate to="/lobby" replace />} />
            <Route path="*" element={<Navigate to="/lobby" replace />} />
          </Routes>
        </main>
      </div>
    </AuthContext.Provider>
  )
}
