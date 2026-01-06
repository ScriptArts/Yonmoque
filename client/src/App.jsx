import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { apiGet, apiPost } from './api'
import { resetSocket } from './socket'
import LoginPage from './pages/LoginPage.jsx'
import LobbyPage from './pages/LobbyPage.jsx'
import RoomPage from './pages/RoomPage.jsx'
import { Button } from "@/components/ui/button"

const AuthContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
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
      <div className="flex min-h-screen flex-col font-sans">
        {user ? (
          <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container flex h-16 items-center justify-between px-4 md:px-8">
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
        <main className="flex-1 container mx-auto p-4 md:p-8 max-w-6xl">
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
