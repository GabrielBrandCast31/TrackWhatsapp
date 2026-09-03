import { useState } from 'react'

import { useAuth } from '../authContext'
import { Badge, Banner } from '../ui'
import Connection from './Connection'
import Crm from './Crm'
import Destinations from './Destinations'
import Manual from './Manual'
import Numbers from './Numbers'
import Prospecting from './Prospecting'
import Users from './Users'

/** Abas que saíram da tela principal e continuam inteiras aqui dentro. */
const ADMIN_TABS = [
  { id: 'prospecting', label: 'Prospecção' },
  { id: 'crm', label: 'CRM' },
  { id: 'numbers', label: 'Cloud API' },
  { id: 'cloud-connection', label: 'Conexão Cloud' },
  { id: 'destinations', label: 'Destinos' },
  { id: 'manual', label: 'Manual' },
  { id: 'users', label: 'Usuários' },
] as const

type AdminTabId = (typeof ADMIN_TABS)[number]['id']

/** Não há segundo login aqui: quem entrou no painel com perfil admin já está
 *  autorizado, e o backend confere o perfil em cada rota destas abas. */
export default function Admin({ onChanged }: { onChanged: () => void }) {
  const { user, isAdmin } = useAuth()
  const [tab, setTab] = useState<AdminTabId>('prospecting')

  if (!isAdmin) {
    return <Banner tone="warn">Área restrita a administradores.</Banner>
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-800 bg-ink-900 px-4 py-3">
        <Badge tone="info">admin</Badge>
        <span className="text-sm text-ink-100">{user?.name || user?.username}</span>
        <span className="text-[11px] text-ink-500">
          módulos completos: varredura no mapa, CRM, abordagem ativa, Cloud API, destinos extras e
          quem tem acesso ao painel.
        </span>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-ink-800">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-xs transition-colors ${
              tab === t.id ? 'border-wa-500 text-ink-100' : 'border-transparent text-ink-500 hover:text-ink-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'prospecting' && <Prospecting onChanged={onChanged} />}
      {tab === 'crm' && <Crm onChanged={onChanged} />}
      {tab === 'numbers' && <Numbers onChanged={onChanged} />}
      {tab === 'cloud-connection' && <Connection onChanged={onChanged} />}
      {tab === 'destinations' && <Destinations onChanged={onChanged} />}
      {tab === 'manual' && <Manual onNavigate={() => undefined} />}
      {tab === 'users' && <Users />}
    </div>
  )
}
