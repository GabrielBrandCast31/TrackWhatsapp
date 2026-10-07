/** Volta do Facebook: o callback do backend redireciona pro painel com o
 *  resultado no fragmento (`/#meta=connected&number=3`, `/#fb_login=<token>`…).
 *
 *  Lido UMA vez, no carregamento do módulo — antes de qualquer contexto ler o
 *  localStorage —, e apagado da barra de endereço na hora: token de login não
 *  pode ficar no histórico nem ser reaproveitado por um F5.
 */
const TAB_KEY = 'wa.tab'
const NUMBER_KEY = 'wa.selectedNumber'

const KEYS = ['meta', 'number', 'meta_error', 'fb_login', 'fb_error', 'fb_linked', 'link_error'] as const
type Key = (typeof KEYS)[number]

const pending: Partial<Record<Key, string>> = {}

function parse() {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return
  const params = new URLSearchParams(hash)
  let found = false
  for (const key of KEYS) {
    const value = params.get(key)
    if (value !== null) {
      pending[key] = value
      found = true
    }
  }
  if (!found) return
  window.history.replaceState(null, '', window.location.pathname + window.location.search)

  // conectou uma linha: volta direto pra aba Rastreamento daquela linha
  if (pending.meta || pending.meta_error) {
    try {
      localStorage.setItem(TAB_KEY, 'tracking')
      if (pending.number) localStorage.setItem(NUMBER_KEY, pending.number)
    } catch {
      // sem storage: a pessoa acha a aba sozinha
    }
  }
}

parse()

/** Devolve o valor e esquece — cada aviso aparece uma vez só. */
export function takeReturn(key: Key): string | null {
  const value = pending[key] ?? null
  delete pending[key]
  return value
}
