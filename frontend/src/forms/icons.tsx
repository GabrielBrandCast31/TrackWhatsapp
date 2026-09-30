/** Ícones dos formulários — SVG inline no traço do resto do painel, pra não
 *  trazer uma biblioteca de ícones só por esta tela. Herdam a cor do texto. */
import type { CSSProperties, ReactNode } from 'react'

type P = { className?: string; style?: CSSProperties }

function I({ className = 'size-4', style, children }: P & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export const AlertCircle = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></I>
export const TriangleAlert = (p: P) => <I {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></I>
export const ArrowDown = (p: P) => <I {...p}><path d="M12 5v14M19 12l-7 7-7-7" /></I>
export const ArrowUp = (p: P) => <I {...p}><path d="M12 19V5M5 12l7-7 7 7" /></I>
export const ArrowLeft = (p: P) => <I {...p}><path d="M19 12H5M12 19l-7-7 7-7" /></I>
export const ArrowRight = (p: P) => <I {...p}><path d="M5 12h14M12 5l7 7-7 7" /></I>
export const Bell = (p: P) => <I {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" /></I>
export const Check = (p: P) => <I {...p}><path d="M20 6 9 17l-5-5" /></I>
export const ChevronDown = (p: P) => <I {...p}><path d="m6 9 6 6 6-6" /></I>
export const ChevronRight = (p: P) => <I {...p}><path d="m9 18 6-6-6-6" /></I>
export const ChevronsDownUp = (p: P) => <I {...p}><path d="m7 20 5-5 5 5M7 4l5 5 5-5" /></I>
export const ChevronsUpDown = (p: P) => <I {...p}><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></I>
export const ClipboardList = (p: P) => <I {...p}><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01" /></I>
export const Copy = (p: P) => <I {...p}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></I>
export const Crosshair = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4" /></I>
export const Download = (p: P) => <I {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></I>
export const ExternalLink = (p: P) => <I {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></I>
export const Eye = (p: P) => <I {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></I>
export const EyeOff = (p: P) => <I {...p}><path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2" /></I>
export const HelpCircle = (p: P) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" /></I>
export const ImageIcon = (p: P) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></I>
export const Inbox = (p: P) => <I {...p}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z" /></I>
export const Keyboard = (p: P) => <I {...p}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10" /></I>
export const Layers = (p: P) => <I {...p}><path d="m12 2 10 5-10 5L2 7l10-5ZM2 17l10 5 10-5M2 12l10 5 10-5" /></I>
export const ListChecks = (p: P) => <I {...p}><path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8" /></I>
export const Loader2 = ({ className = 'size-4', style }: P) => (
  <I className={`${className} animate-spin`} style={style}><path d="M21 12a9 9 0 1 1-6.2-8.6" /></I>
)
export const MonitorPlay = (p: P) => <I {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4M10 7.5v5l4-2.5-4-2.5Z" /></I>
export const Palette = (p: P) => <I {...p}><circle cx="13.5" cy="6.5" r=".5" /><circle cx="17.5" cy="10.5" r=".5" /><circle cx="8.5" cy="7.5" r=".5" /><circle cx="6.5" cy="12.5" r=".5" /><path d="M12 2a10 10 0 0 0 0 20 1.7 1.7 0 0 0 1.7-1.7c0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.7 1.7 0 0 1 1.7-1.7h2A5.6 5.6 0 0 0 22 10.8C22 5.9 17.5 2 12 2Z" /></I>
export const Plus = (p: P) => <I {...p}><path d="M12 5v14M5 12h14" /></I>
export const RotateCcw = (p: P) => <I {...p}><path d="M3 12a9 9 0 1 0 9-9 9.8 9.8 0 0 0-6.7 2.7L3 8M3 3v5h5" /></I>
export const Search = (p: P) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
export const Settings2 = (p: P) => <I {...p}><path d="M20 7h-9M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></I>
export const Shield = (p: P) => <I {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /></I>
export const Sparkles = (p: P) => <I {...p}><path d="M9.9 15.5A2 2 0 0 0 8.5 14l-6.1-1.6a.5.5 0 0 1 0-1L8.5 10A2 2 0 0 0 9.9 8.5l1.6-6.1a.5.5 0 0 1 1 0L14 8.5a2 2 0 0 0 1.5 1.5l6.1 1.6a.5.5 0 0 1 0 1L15.5 14a2 2 0 0 0-1.5 1.5l-1.6 6.1a.5.5 0 0 1-1 0ZM20 3v4M22 5h-4" /></I>
export const Star = (p: P) => <I {...p}><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2Z" /></I>
export const Trash2 = (p: P) => <I {...p}><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" /></I>
export const Upload = (p: P) => <I {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></I>
export const X = (p: P) => <I {...p}><path d="M18 6 6 18M6 6l12 12" /></I>
