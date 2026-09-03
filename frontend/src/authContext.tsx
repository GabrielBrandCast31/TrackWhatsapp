import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { authApi, session, setLogoutHandler, type AuthUser } from './api'

type AuthState = {
  user: AuthUser | null
  /** ainda checando o token guardado — evita piscar a tela de login no F5 */
  checking: boolean
  isAdmin: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  setUser: (user: AuthUser) => void
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [checking, setChecking] = useState(true)

  const logout = useCallback(() => {
    session.clear()
    setUser(null)
  }, [])

  // qualquer 401 vindo de qualquer chamada derruba a sessão na tela inteira
  useEffect(() => {
    setLogoutHandler(() => setUser(null))
    return () => setLogoutHandler(null)
  }, [])

  // token guardado do acesso anterior: só vale se o backend confirmar
  useEffect(() => {
    if (!session.access() && !session.refresh()) {
      setChecking(false)
      return
    }
    void authApi
      .me()
      .then(setUser)
      .catch(() => {
        session.clear()
        setUser(null)
      })
      .finally(() => setChecking(false))
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const pair = await authApi.login(username, password)
    session.save(pair)
    setUser(pair.user)
  }, [])

  const value = useMemo<AuthState>(
    () => ({ user, checking, isAdmin: user?.role === 'admin', login, logout, setUser }),
    [user, checking, login, logout],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>')
  return ctx
}
