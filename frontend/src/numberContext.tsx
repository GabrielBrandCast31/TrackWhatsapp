import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { evolutionApi, type EvoInstance } from './api'

/** Linha de WhatsApp selecionada — uma instância da Evolution API.
 *
 * `undefined` = "Todas as linhas": as telas mostram a base inteira e o backend
 * nao filtra nada. Qualquer acao de ESCRITA que precise de uma linha (disparar
 * abordagem, criar varredura) exige uma selecao — por isso `requireId`.
 *
 * A escolha vive no localStorage: trocar de aba ou recarregar nao joga o usuario
 * de volta pra base de outro cliente.
 */
const STORAGE_KEY = 'wa.selectedNumber'

type NumberContextValue = {
  numberId: number | undefined
  setNumberId: (id: number | undefined) => void
  numbers: EvoInstance[]
  current: EvoInstance | undefined
  loading: boolean
  reload: () => Promise<void>
  labelOf: (id: number | null | undefined) => string
}

const NumberContext = createContext<NumberContextValue | null>(null)

function readStored(): number | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? Number(raw) || undefined : undefined
  } catch {
    return undefined
  }
}

export function NumberProvider({ children }: { children: ReactNode }) {
  const [numbers, setNumbers] = useState<EvoInstance[]>([])
  const [numberId, setId] = useState<number | undefined>(readStored)
  const [loading, setLoading] = useState(true)

  const setNumberId = useCallback((id: number | undefined) => {
    setId(id)
    try {
      if (id === undefined) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, String(id))
    } catch {
      // navegador sem storage: a selecao vale so pra sessao atual
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await evolutionApi.list()
      setNumbers(rows)
      setId((prev) => {
        // linha apagada ou nunca escolhida: cai na padrao, nao numa base alheia
        if (prev !== undefined && rows.some((n) => n.id === prev)) return prev
        if (prev !== undefined) {
          try {
            localStorage.removeItem(STORAGE_KEY)
          } catch {
            /* ignora */
          }
        }
        return rows.find((n) => n.is_default)?.id ?? rows[0]?.id
      })
    } catch {
      setNumbers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const value = useMemo<NumberContextValue>(() => {
    const current = numbers.find((n) => n.id === numberId)
    return {
      numberId,
      setNumberId,
      numbers,
      current,
      loading,
      reload,
      labelOf: (id) => {
        if (id === null || id === undefined) return 'Sem número'
        return numbers.find((n) => n.id === id)?.label ?? `#${id}`
      },
    }
  }, [numbers, numberId, setNumberId, loading, reload])

  return <NumberContext.Provider value={value}>{children}</NumberContext.Provider>
}

export function useNumber(): NumberContextValue {
  const ctx = useContext(NumberContext)
  if (!ctx) throw new Error('useNumber precisa estar dentro de <NumberProvider>')
  return ctx
}

/** Id da linha para acoes de escrita, ou `null` se nenhuma estiver selecionada. */
export function requireId(numberId: number | undefined): number | null {
  return numberId ?? null
}

export const NO_NUMBER_MESSAGE =
  'Escolha uma linha de WhatsApp no topo da tela — essa ação precisa saber por qual número ela vale.'

export const NO_INSTANCE_MESSAGE =
  'Nenhuma instância cadastrada. Comece na aba Conexão: informe a URL da sua Evolution API, a apikey e o nome da instância.'
