import { useCallback, useEffect, useState } from 'react'

import { api, type Stats } from './api'
import Connection from './tabs/Connection'
import Conversions from './tabs/Conversions'
import Destinations from './tabs/Destinations'
import Leads from './tabs/Leads'
import Manual from './tabs/Manual'

const TABS = [
  { id: 'connection', label: 'Conexão' },
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

export default function App() {
  const [tab, setTab] = useState<TabId>('connection')
  const [stats, setStats] = useState<Stats | null>(null)

  const refresh = useCallback(() => {
    void api.stats().then(setStats).catch(() => setStats(null))
  }, [])

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
              Click to WhatsApp → ctwa_clid → evento de conversão na campanha
            </p>
          </div>
          {stats && (
            <div className="flex flex-wrap gap-7">
              <Stat label="Leads" value={stats.contacts} />
              <Stat label="Com atribuição" value={stats.attributed_contacts} accent />
              <Stat label="Conversões" value={stats.conversions} />
              <Stat label="Envios OK" value={stats.dispatches.ok ?? 0} />
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
        {tab === 'connection' && <Connection onChanged={refresh} />}
        {tab === 'leads' && <Leads onChanged={refresh} />}
        {tab === 'conversions' && <Conversions onChanged={refresh} />}
        {tab === 'destinations' && <Destinations onChanged={refresh} />}
        {tab === 'manual' && <Manual onNavigate={(t) => setTab(t as TabId)} />}
      </main>
    </div>
  )
}
