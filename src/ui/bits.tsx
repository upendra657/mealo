/**
 * The small shared pieces: icons, a toast, a bottom sheet, a status bar.
 *
 * Kept in one file because each is a dozen lines and splitting them would
 * mean six imports at the top of every screen to say "back arrow".
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* ------------------------------------------------------------------ icons */

type IconProps = { size?: number };
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function Chevron({ size = 15, dir = 'left' }: IconProps & { dir?: 'left' | 'right' | 'down' }) {
  const d =
    dir === 'left' ? 'm15 18-6-6 6-6' : dir === 'right' ? 'm9 18 6-6-6-6' : 'm6 9 6 6 6-6';
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={2}>
      <path d={d} />
    </svg>
  );
}

export function Plus({ size = 19 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={2.2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function Bin({ size = 17 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke}>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function Tick({ size = 15 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={2.2}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function Target({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={1.6}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

export function Gear({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={1.6}>
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={1.8}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function Stethoscope({ size = 24 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={1.5}>
      <path d="M9 3v6a5 5 0 0 0 10 0V3" />
      <path d="M6 3v7a7 7 0 0 0 7 7" />
      <circle cx="19" cy="17" r="3" />
    </svg>
  );
}

export function Cutlery({ size = 24 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={1.5}>
      <path d="M4 4v7a3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V4" />
      <path d="M7 4v6M7 14v6" />
      <path d="M17 4c-1.5 2-2 4-2 6s.5 3 2 3 2-1 2-3-.5-4-2-6z" />
      <path d="M17 13v7" />
    </svg>
  );
}

export function Pill({ size = 24 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={1.5}>
      <rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)" />
      <path d="M8.5 8.5 15.5 15.5" />
    </svg>
  );
}

export function Code({ size = 24 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} strokeWidth={1.5}>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
    </svg>
  );
}

/* ------------------------------------------------------------------ toast */

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 1900);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className={msg ? 'toast on' : 'toast'} role="status" aria-live="polite">
        {msg}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------------ sheet */

/**
 * Bottom sheet. Used for the amount pickers and the big-meal check.
 *
 * Stays mounted while closing so the slide-out animation can finish, and
 * traps nothing — everything behind it is inert because the scrim covers it.
 */
export function Sheet({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={open ? 'sheet-scrim on' : 'sheet-scrim'} onClick={onClose} />
      <div
        className={open ? 'sheet on' : 'sheet'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-hidden={!open}
      >
        <div className="grab" />
        {children}
      </div>
    </>
  );
}

/* --------------------------------------------------------------- headings */

export function Header({
  back,
  backLabel,
  title,
  right,
}: {
  back?: () => void;
  backLabel?: string;
  title?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="top">
      {back && (
        <button className="back" onClick={back}>
          <Chevron />
          {backLabel ?? 'Back'}
        </button>
      )}
      {title}
      <div className="grow" />
      {right}
    </div>
  );
}

/**
 * A quantity as you would say it: "2", not "2.0"; "1.25", not "1.250".
 *
 * Lives here because both the log flow and the day list show quantities, and
 * this file already existed for exactly that. Two copies of a formatter is how
 * the parser ended up with its own stale unit list.
 *
 * Rounded to two decimals, which is as fine as the picker lets you type and
 * finer than any kitchen measure deserves.
 */
export function fmtQty(q: number | null | undefined): string {
  if (q === null || q === undefined || !Number.isFinite(q)) return '';
  return String(Math.round(q * 100) / 100);
}
