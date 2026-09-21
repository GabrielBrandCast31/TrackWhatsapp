import type { ComponentType } from 'react'

import { IconChevronLeft, IconClose, Logo } from './icons'

export type NavItem = {
  id: string
  label: string
  hint: string
  Icon: ComponentType<{ className?: string }>
}

const VERSION = 'v.1.0.0'

function Item({
  item,
  active,
  collapsed,
  onSelect,
}: {
  item: NavItem
  active: boolean
  collapsed: boolean
  onSelect: () => void
}) {
  const { Icon } = item
  return (
    <button
      type="button"
      onClick={onSelect}
      title={collapsed ? item.label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`group relative flex w-full items-center gap-3 rounded-xl border px-2 py-2 text-left transition-colors ${
        active
          ? 'border-ink-700 bg-ink-850 text-ink-100'
          : 'border-transparent text-ink-300 hover:border-ink-800 hover:bg-ink-850/60 hover:text-ink-100'
      }`}
    >
      {/* traço verde da aba ativa — o mesmo destaque que a navegação antiga usava */}
      <span
        className={`absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-wa-500 transition-opacity ${
          active ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition-colors ${
          active
            ? 'border-transparent bg-wa-500 text-ink-950'
            : 'border-ink-800 bg-ink-900 text-ink-300 group-hover:border-ink-700 group-hover:text-ink-100'
        }`}
      >
        <Icon />
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm ${active ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>
          <span className="block truncate text-[11px] leading-tight text-ink-500">{item.hint}</span>
        </span>
      )}
      {/* tooltip de quando a barra está fechada */}
      {collapsed && (
        <span className="pointer-events-none absolute left-full z-50 ml-2 hidden whitespace-nowrap rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-xs text-ink-100 shadow-xl group-hover:block">
          {item.label}
        </span>
      )}
    </button>
  )
}

export default function Sidebar({
  items,
  active,
  onSelect,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onCloseMobile,
}: {
  items: NavItem[]
  active: string
  onSelect: (id: string) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  mobileOpen: boolean
  onCloseMobile: () => void
}) {
  return (
    <>
      {/* fundo escuro do menu em tela pequena */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-ink-950/70 backdrop-blur-sm lg:hidden" onClick={onCloseMobile} />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-ink-800 bg-ink-900 transition-[width,transform] duration-200 lg:static lg:translate-x-0 ${
          collapsed ? 'w-[76px]' : 'w-[248px]'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div
          className={`flex h-16 shrink-0 items-center gap-2.5 border-b border-ink-800 px-3 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          <Logo />
          {!collapsed && (
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-semibold text-ink-100">Conversion</p>
              <p className="truncate text-[11px] text-wa-500">Tracker</p>
            </div>
          )}
          {!collapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="Recolher menu"
              aria-label="Recolher menu"
              className="hidden h-7 w-7 shrink-0 place-items-center rounded-lg border border-ink-800 text-ink-500 transition-colors hover:border-ink-700 hover:text-ink-100 lg:grid"
            >
              <IconChevronLeft className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Fechar menu"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-ink-800 text-ink-500 hover:text-ink-100 lg:hidden"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-3 py-4">
          {items.map((item) => (
            <Item
              key={item.id}
              item={item}
              active={item.id === active}
              collapsed={collapsed}
              onSelect={() => {
                onSelect(item.id)
                onCloseMobile()
              }}
            />
          ))}
        </nav>

        <div className="shrink-0 border-t border-ink-800 px-3 py-3">
          {collapsed ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              title="Expandir menu"
              aria-label="Expandir menu"
              className="mx-auto hidden h-8 w-8 place-items-center rounded-lg border border-ink-800 text-ink-500 transition-colors hover:border-ink-700 hover:text-ink-100 lg:grid"
            >
              <IconChevronLeft className="h-4 w-4 rotate-180" />
            </button>
          ) : (
            <p className="text-center text-[10px] uppercase tracking-[0.25em] text-ink-500">{VERSION}</p>
          )}
        </div>
      </aside>
    </>
  )
}
