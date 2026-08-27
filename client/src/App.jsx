import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { apiGet, apiPost } from './api'
import { resetSocket } from './socket'
import { AuthContext, useAuth } from './auth'
import LoginPage from './pages/LoginPage.jsx'
import LobbyPage from './pages/LobbyPage.jsx'
import RoomPage from './pages/RoomPage.jsx'
import { Button } from "@/components/ui/button"

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
          <header className="w-full shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container flex h-14 items-center justify-between px-4 md:px-8">
              <div className="flex items-center gap-3">
                <img className="h-9 w-9 rounded-md border" src="/icon.png" alt="ヨンモク アイコン" />
                <div className="text-xl font-bold tracking-tight text-secondary">ヨンモク</div>
              </div>
              <div className="flex items-center gap-4">
                <span className="hidden md:inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary font-mono">
                  {user.nickname || '名無しプレイヤー'}
                </span>
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
            <Route path="/" element={<Navigate to="/lobby" replace />} />
            <Route path="*" element={<Navigate to="/lobby" replace />} />
          </Routes>
        </main>
      </div>
    </AuthContext.Provider>
  )
}
