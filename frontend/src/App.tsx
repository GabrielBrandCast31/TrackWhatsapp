import { useCallback, useEffect, useState } from 'react'

import AccountBar from './AccountBar'
import { api, type Stats } from './api'
import { AuthProvider, useAuth } from './authContext'
import Login from './Login'
import { NumberProvider, useNumber } from './numberContext'
import Admin from './tabs/Admin'
import Conversions from './tabs/Conversions'
import CrmNumber from './tabs/CrmNumber'
import Instances from './tabs/Instances'
import Leads from './tabs/Leads'
import Tracking from './tabs/Tracking'

const TABS = [
  { id: 'instances', label: 'Conexão' },
  { id: 'tracking', label: 'Rastreamento' },
  { id: 'crm', label: 'CRM' },
  { id: 'leads', label: 'Leads' },
  { id: 'conversions', label: 'Conversões' },
  // só admin: o backend recusa as rotas de dentro dela pra perfil de operação
  { id: 'admin', label: 'Admin', adminOnly: true },
] as const

type TabId = (typeof TABS)[number]['id']

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="min-w-24">
      <p className="text-[11px] uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-0.5 text-xl font-semibold tabular-nums ${accent ? 'text-wa-500' : 'text-ink-100'}`}>
        {value}
      </p>
    </div>
  )
}

/** Seletor da linha em uso. Tudo que as abas mostram passa por ele. */
function NumberPicker() {
  const { numbers, numberId, setNumberId, current, loading } = useNumber()

  if (loading) return <span className="text-xs text-ink-500">carregando linhas…</span>
  if (numbers.length === 0) {
    return <span className="text-xs text-amber-300">nenhuma linha cadastrada — comece em Conexão</span>
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-ink-500">Linha</span>
      <select
        value={numberId ?? 'all'}
        onChange={(e) => setNumberId(e.target.value === 'all' ? undefined : Number(e.target.value))}
        className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-100"
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
      {current && ['open', 'connected'].includes(current.state ?? '') && (
        <span className="text-[11px] text-wa-500">conectada</span>
      )}
      {current && current.state && !['open', 'connected'].includes(current.state) && (
        <span className="text-[11px] text-amber-300">{current.state}</span>
      )}
      {!current && <span className="text-[11px] text-ink-500">visão consolidada</span>}
    </div>
  )
}

function Shell() {
  const [tab, setTab] = useState<TabId>('instances')
  const [stats, setStats] = useState<Stats | null>(null)
  const { numberId } = useNumber()
  const { isAdmin } = useAuth()
  const tabs = TABS.filter((t) => isAdmin || !('adminOnly' in t && t.adminOnly))

  const refresh = useCallback(() => {
    void api
      .stats(numberId)
      .then(setStats)
      .catch(() => setStats(null))
  }, [numberId])

  useEffect(refresh, [refresh])

  return (
    <div className="min-h-full">
      <header className="border-b border-ink-800 bg-ink-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-6 px-6 py-5">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              WhatsApp <span className="text-wa-500">Conversion Tracker</span>
            </h1>
            <p className="mt-0.5 text-xs text-ink-500">
              Evolution API → ctwa_clid do anúncio → palavra-chave do atendente → conversão no Meta
            </p>
            <div className="mt-3">
              <NumberPicker />
            </div>
          </div>
          <div className="flex flex-col items-end gap-4">
            <AccountBar />
            {stats && (
              <div className="flex flex-wrap justify-end gap-7">
                <Stat label="Leads" value={stats.contacts} />
                <Stat label="Com atribuição" value={stats.attributed_contacts} accent />
                <Stat label="Conversões" value={stats.conversions} />
                <Stat label="Por palavra-chave" value={stats.rule_conversions ?? 0} accent />
                <Stat label="Regras" value={stats.rules ?? 0} />
                <Stat label="Falhas" value={stats.dispatches.error ?? 0} />
              </div>
            )}
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1400px] gap-1 px-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                tab === t.id
                  ? 'border-wa-500 text-ink-100'
                  : 'border-transparent text-ink-500 hover:text-ink-300'
              } ${t.id === 'admin' ? 'ml-auto' : ''}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-6">
        {tab === 'instances' && <Instances onChanged={refresh} />}
        {tab === 'tracking' && <Tracking onChanged={refresh} />}
        {tab === 'crm' && <CrmNumber onChanged={refresh} />}
        {tab === 'leads' && <Leads onChanged={refresh} />}
        {tab === 'conversions' && <Conversions onChanged={refresh} />}
        {tab === 'admin' && isAdmin && <Admin onChanged={refresh} />}
      </main>
    </div>
  )
}

/** Nada carrega antes do login: as chamadas de dentro do painel só existem
 *  depois que há um token — senão o primeiro render dispara uma enxurrada de 401. */
function Gate() {
  const { user, checking } = useAuth()

  if (checking) {
    return (
      <div className="flex min-h-full items-center justify-center">
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
