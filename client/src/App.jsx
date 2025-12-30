import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { apiGet, apiPost } from './api'
import { resetSocket } from './socket'
import LoginPage from './pages/LoginPage.jsx'
import LobbyPage from './pages/LobbyPage.jsx'
import RoomPage from './pages/RoomPage.jsx'

const AuthContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="page center">
        <div className="card">読み込み中...</div>
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
      <div className="app-shell">
        {user ? (
          <header className="topbar">
            <div className="brand">ヨンモク</div>
            <div className="topbar-meta">
              <span className="user-pill">
                {user.nickname || '名無しプレイヤー'}
              </span>
              <button className="secondary" onClick={authValue.logout}>
                ログアウト
              </button>
            </div>
          </header>
        ) : null}
        <main className="content">
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
