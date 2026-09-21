import { useCallback, useEffect, useState } from 'react'

import AccountBar from './AccountBar'
import { api, type Stats } from './api'
import { AuthProvider, useAuth } from './authContext'
import {
  IconBoard,
  IconMenu,
  IconPlug,
  IconRadar,
  IconRefresh,
  IconShield,
  IconTarget,
  IconTrending,
  IconUsers,
  Logo,
} from './icons'
import Login from './Login'
import { NumberProvider, useNumber } from './numberContext'
import Sidebar from './Sidebar'
import Admin from './tabs/Admin'
import Attribution from './tabs/Attribution'
import Conversions from './tabs/Conversions'
import CrmNumber from './tabs/CrmNumber'
import Instances from './tabs/Instances'
import Leads from './tabs/Leads'
import Tracking from './tabs/Tracking'

const TABS = [
  { id: 'instances', label: 'Conexão', hint: 'Evolution API', Icon: IconPlug },
  { id: 'tracking', label: 'Rastreamento', hint: 'Links e ctwa_clid', Icon: IconRadar },
  { id: 'attribution', label: 'Atribuição', hint: 'Anúncio × conversa', Icon: IconTarget },
  { id: 'crm', label: 'CRM', hint: 'Funil e atendimento', Icon: IconBoard },
  { id: 'leads', label: 'Leads', hint: 'Base de contatos', Icon: IconUsers },
  { id: 'conversions', label: 'Conversões', hint: 'Envios ao Meta', Icon: IconTrending },
  // só admin: o backend recusa as rotas de dentro dela pra perfil de operação
  { id: 'admin', label: 'Admin', hint: 'Usuários e acessos', Icon: IconShield, adminOnly: true },
] as const

type TabId = (typeof TABS)[number]['id']

const COLLAPSE_KEY = 'wa.sidebarCollapsed'

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900 px-3.5 py-2.5">
      <p className="truncate text-[10px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${accent ? 'text-wa-500' : 'text-ink-100'}`}>{value}</p>
    </div>
  )
}

/** Seletor da linha em uso. Tudo que as abas mostram passa por ele. */
function NumberPicker() {
  const { numbers, numberId, setNumberId, current, loading } = useNumber()

  if (loading) return <span className="hidden text-xs text-ink-500 sm:block">carregando linhas…</span>
  if (numbers.length === 0) {
    return <span className="hidden text-xs text-amber-300 sm:block">nenhuma linha — comece em Conexão</span>
  }

  const connected = current && ['open', 'connected'].includes(current.state ?? '')
  const dot = !current ? 'bg-ink-500' : connected ? 'bg-wa-500' : 'bg-amber-400'

  return (
    <div className="flex items-center gap-2 rounded-lg border border-ink-800 bg-ink-850 pl-2.5 pr-1 py-1">
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} title={current?.state ?? 'visão consolidada'} />
      <span className="hidden text-[10px] uppercase tracking-wide text-ink-500 md:block">Linha</span>
      <select
        value={numberId ?? 'all'}
        onChange={(e) => setNumberId(e.target.value === 'all' ? undefined : Number(e.target.value))}
        className="max-w-[190px] truncate bg-transparent py-0.5 text-sm text-ink-100 focus:outline-none"
      >
        {numbers.map((n) => (
          <option key={n.id} value={n.id}>
            {n.label}
            {n.display_phone_number ? ` · ${n.display_phone_number}` : ''}
            {n.active ? '' : ' (inativa)'}
          </option>
        ))}
        <option value="all">Todas as linhas</option>
      </select>
    </div>
  )
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function Shell() {
  const [tab, setTab] = useState<TabId>('instances')
  const [stats, setStats] = useState<Stats | null>(null)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [menuOpen, setMenuOpen] = useState(false)
  const { numberId } = useNumber()
  const { user, isAdmin } = useAuth()
  const tabs = TABS.filter((t) => isAdmin || !('adminOnly' in t && t.adminOnly))
  const active = tabs.find((t) => t.id === tab) ?? tabs[0]

  const refresh = useCallback(() => {
    void api
      .stats(numberId)
      .then(setStats)
      .catch(() => setStats(null))
  }, [numberId])

  useEffect(refresh, [refresh])

  const toggleCollapsed = () =>
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1')
      } catch {
        // navegador sem storage: a preferência vale só pra sessão atual
      }
      return !v
    })

  return (
    <div className="flex h-full overflow-hidden bg-ink-950">
      <Sidebar
        items={tabs}
        active={active.id}
        onSelect={(id) => setTab(id as TabId)}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={menuOpen}
        onCloseMobile={() => setMenuOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/80 px-3 backdrop-blur lg:px-6">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Abrir menu"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-ink-800 text-ink-300 hover:text-ink-100 lg:hidden"
          >
            <IconMenu />
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-ink-300">
              Olá <span className="font-semibold text-ink-100">{user?.name || user?.username}</span>, seja bem-vindo ao{' '}
              <span className="font-semibold text-wa-500">Conversion Tracker</span>!
            </p>
            <p className="hidden truncate text-[11px] text-ink-500 sm:block">
              Evolution API → ctwa_clid do anúncio → palavra-chave do atendente → conversão no Meta
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <NumberPicker />
            <button
              type="button"
              onClick={refresh}
              title="Atualizar indicadores"
              aria-label="Atualizar indicadores"
              className="grid h-9 w-9 place-items-center rounded-lg border border-ink-800 text-ink-300 transition-colors hover:border-ink-700 hover:text-wa-500"
            >
              <IconRefresh />
            </button>
            <span className="mx-1 hidden h-7 w-px bg-ink-800 sm:block" />
            <AccountBar />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1500px] px-4 py-5 lg:px-6">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-ink-800 bg-ink-900 text-wa-500">
                  <active.Icon className="h-5 w-5" />
                </span>
                <div>
                  <h1 className="text-lg font-semibold tracking-tight text-ink-100">{active.label}</h1>
                  <p className="text-xs text-ink-500">{active.hint}</p>
                </div>
              </div>
            </div>

            {stats && (
              <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <Stat label="Leads" value={stats.contacts} />
                <Stat label="Com atribuição" value={stats.attributed_contacts} accent />
                <Stat label="Conversões" value={stats.conversions} />
                <Stat label="Por palavra-chave" value={stats.rule_conversions ?? 0} accent />
                <Stat label="Regras" value={stats.rules ?? 0} />
                <Stat label="Falhas" value={stats.dispatches.error ?? 0} />
              </div>
            )}

            {tab === 'instances' && <Instances onChanged={refresh} />}
            {tab === 'tracking' && <Tracking onChanged={refresh} />}
            {tab === 'attribution' && <Attribution />}
            {tab === 'crm' && <CrmNumber onChanged={refresh} />}
            {tab === 'leads' && <Leads onChanged={refresh} />}
            {tab === 'conversions' && <Conversions onChanged={refresh} />}
            {tab === 'admin' && isAdmin && <Admin onChanged={refresh} />}
          </div>
        </main>
      </div>
    </div>
  )
}

/** Nada carrega antes do login: as chamadas de dentro do painel só existem
 *  depois que há um token — senão o primeiro render dispara uma enxurrada de 401. */
function Gate() {
  const { user, checking } = useAuth()

  if (checking) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3">
        <Logo className="h-11 w-11 animate-pulse" />
        <p className="text-sm text-ink-500">carregando…</p>
      </div>
    )
  }
  if (!user) return <Login />

  return (
    <NumberProvider>
      <Shell />
    </NumberProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
