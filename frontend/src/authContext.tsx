import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { authApi, session, setLogoutHandler, type AuthUser, type TokenPair } from './api'
import { takeReturn } from './oauthReturn'

/** "Entrar com Facebook" voltou com um token curto: troca uma vez só, no nível do
 *  módulo — o StrictMode roda o efeito duas vezes e o token não vale duas trocas. */
const fbToken = takeReturn('fb_login')
const fbReturnError = takeReturn('fb_error')
let fbExchange: Promise<TokenPair> | null = null
function exchangeFacebook(): Promise<TokenPair> | null {
  if (fbToken) fbExchange ??= authApi.facebookExchange(fbToken)
  return fbExchange
}

type AuthState = {
  user: AuthUser | null
  /** ainda checando o token guardado — evita piscar a tela de login no F5 */
  checking: boolean
  isAdmin: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  setUser: (user: AuthUser) => void
  /** "Entrar com Facebook" recusado (sem vínculo, expirou…) — a tela de login mostra */
  facebookError: string | null
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [checking, setChecking] = useState(true)
  const [facebookError, setFacebookError] = useState<string | null>(fbReturnError)

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
    const viaFacebook = exchangeFacebook()
    if (viaFacebook) {
      void viaFacebook
        .then((pair) => {
          session.save(pair)
          setUser(pair.user)
        })
        .catch((e) => {
          setFacebookError((e as Error).message)
          setUser(null)
        })
        .finally(() => setChecking(false))
      return
    }
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
    () => ({ user, checking, isAdmin: user?.role === 'admin', login, logout, setUser, facebookError }),
    [user, checking, login, logout, facebookError],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth precisa estar dentro de <AuthProvider>')
  return ctx
}
