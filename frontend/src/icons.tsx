/** Ícones do shell — SVG inline pra não trazer dependência nova só por desenho.
 *  Todos herdam a cor do texto e vivem numa caixa 24×24. */
type Props = { className?: string }

const base = 'h-[18px] w-[18px]'
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

function Svg({ className, children }: Props & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? base} {...stroke}>
      {children}
    </svg>
  )
}

/** Conexão — um plugue. */
export function IconPlug(p: Props) {
  return (
    <Svg {...p}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
      <path d="M12 17v4" />
    </Svg>
  )
}

/** Rastreamento — ondas de radar. */
export function IconRadar(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2" />
      <path d="M8.5 15.5a5 5 0 0 1 0-7" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M5.5 18.5a9 9 0 0 1 0-13" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </Svg>
  )
}

/** Atribuição — alvo. */
export function IconTarget(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 4V2M12 22v-2M4 12H2M22 12h-2" />
    </Svg>
  )
}

/** CRM — colunas de kanban. */
export function IconBoard(p: Props) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="5.5" height="16" rx="1.5" />
      <rect x="10.5" y="4" width="5.5" height="10" rx="1.5" />
      <rect x="18" y="4" width="3" height="13" rx="1.5" />
    </Svg>
  )
}

/** Leads — pessoas. */
export function IconUsers(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 6.3" />
      <path d="M17.5 14.6a5.5 5.5 0 0 1 3 4.9" />
    </Svg>
  )
}

/** Conversões — curva subindo. */
export function IconTrending(p: Props) {
  return (
    <Svg {...p}>
      <path d="M3 17l5.5-5.5 3.5 3.5L21 6" />
      <path d="M15 6h6v6" />
    </Svg>
  )
}

/** Admin — escudo. */
export function IconShield(p: Props) {
  return (
    <Svg {...p}>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3Z" />
      <path d="M9.5 12l1.8 1.8 3.4-3.6" />
    </Svg>
  )
}

export function IconChevronLeft(p: Props) {
  return (
    <Svg {...p}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Svg>
  )
}

export function IconChevronDown(p: Props) {
  return (
    <Svg {...p}>
      <path d="m6 9.5 6 6 6-6" />
    </Svg>
  )
}

export function IconMenu(p: Props) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  )
}

export function IconRefresh(p: Props) {
  return (
    <Svg {...p}>
      <path d="M20 11a8 8 0 0 0-13.7-5.3L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 13.7 5.3L20 16" />
      <path d="M20 20v-4h-4" />
    </Svg>
  )
}

export function IconKey(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="15" r="3.5" />
      <path d="m10.5 12.5 7-7M15.5 7.5l2 2M18 5l2 2" />
    </Svg>
  )
}

export function IconLogout(p: Props) {
  return (
    <Svg {...p}>
      <path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
      <path d="M10 12h10M17 9l3 3-3 3" />
    </Svg>
  )
}

export function IconClose(p: Props) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  )
}

/** Marca do produto — balão de conversa com o traço de conversão dentro. */
export function Logo({ className = 'h-9 w-9' }: Props) {
  return (
    <span
      className={`${className} inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-wa-500 to-wa-600 text-ink-950 shadow-[0_6px_16px_-8px_var(--color-wa-500)]`}
    >
      <svg viewBox="0 0 24 24" className="h-[60%] w-[60%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-5A8.5 8.5 0 1 1 21 11.5Z" />
        <path d="M8.5 13.2 11 10.6l2 2 3-3.4" />
      </svg>
    </span>
  )
}
