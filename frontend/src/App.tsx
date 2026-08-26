import { useCallback, useEffect, useState } from 'react'

import { api, type Stats } from './api'
import { NumberProvider, useNumber } from './numberContext'
import Connection from './tabs/Connection'
import Numbers from './tabs/Numbers'
import Conversions from './tabs/Conversions'
import Crm from './tabs/Crm'
import Destinations from './tabs/Destinations'
import Leads from './tabs/Leads'
import Manual from './tabs/Manual'
import Prospecting from './tabs/Prospecting'

const TABS = [
  { id: 'numbers', label: 'Números' },
  { id: 'connection', label: 'Conexão' },
  { id: 'prospecting', label: 'Prospecção' },
  { id: 'crm', label: 'CRM' },
  { id: 'leads', label: 'Leads' },
  { id: 'conversions', label: 'Conversões' },
  { id: 'destinations', label: 'Destinos' },
  { id: 'manual', label: 'Manual' },
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
    return <span className="text-xs text-amber-300">nenhuma linha cadastrada — comece em Números</span>
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
      {current && !current.active && <span className="text-[11px] text-amber-300">linha inativa</span>}
      {!current && <span className="text-[11px] text-ink-500">visão consolidada</span>}
    </div>
  )
}

function Shell() {
  const [tab, setTab] = useState<TabId>('numbers')
  const [stats, setStats] = useState<Stats | null>(null)
  const { numberId } = useNumber()

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
              WhatsApp <span className="text-wa-500">CRM & Conversion Tracker</span>
            </h1>
            <p className="mt-0.5 text-xs text-ink-500">
              Varredura por raio → abordagem ativa → resposta no WhatsApp → conversão na campanha
            </p>
            <div className="mt-3">
              <NumberPicker />
            </div>
          </div>
          {stats && (
            <div className="flex flex-wrap gap-7">
              <Stat label="Prospects" value={stats.prospects} />
              <Stat label="Abordados" value={stats.outreach_sent} />
              <Stat label="Responderam" value={stats.prospects_replied} accent />
              <Stat label="Leads" value={stats.contacts} />
              <Stat label="Com atribuição" value={stats.attributed_contacts} accent />
              <Stat label="Conversões" value={stats.conversions} />
              <Stat label="Falhas" value={stats.dispatches.error ?? 0} />
            </div>
          )}
        </div>
        <nav className="mx-auto flex max-w-[1400px] gap-1 px-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                tab === t.id
                  ? 'border-wa-500 text-ink-100'
                  : 'border-transparent text-ink-500 hover:text-ink-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-6">
        {tab === 'numbers' && <Numbers onChanged={refresh} />}
        {tab === 'connection' && <Connection onChanged={refresh} />}
        {tab === 'prospecting' && <Prospecting onChanged={refresh} />}
        {tab === 'crm' && <Crm onChanged={refresh} />}
        {tab === 'leads' && <Leads onChanged={refresh} />}
        {tab === 'conversions' && <Conversions onChanged={refresh} />}
        {tab === 'destinations' && <Destinations onChanged={refresh} />}
        {tab === 'manual' && <Manual onNavigate={(t) => setTab(t as TabId)} />}
      </main>
    </div>
  )
}

export default function App() {
  return (
    <NumberProvider>
      <Shell />
    </NumberProvider>
  )
}
