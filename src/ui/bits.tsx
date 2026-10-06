/**
 * The small shared pieces: icons, a toast, a bottom sheet, the scroll wheel.
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

/* ------------------------------------------------------------------ wheel */

/**
 * The scroll picker.
 *
 * Snap points at a fixed row height, the live value read back from
 * scrollTop. Deliberately not a <select>: on a phone this is the control
 * people already know from every other tracker, and it shows neighbouring
 * values, which a native picker on desktop does not.
 */
export function Wheel({
  values,
  value,
  render,
  onChange,
}: {
  values: (string | number)[];
  value: string | number;
  render: (v: string | number) => string;
  onChange: (v: string | number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  /** The last value this wheel itself reported, so it does not chase its own tail. */
  const mine = useRef<string | number | null>(null);
  const ROW = 40;

  // Follow the value when something else changes it — typing 37 in the box
  // should move the wheel to 37. A change this wheel produced is ignored:
  // scrolling to where the finger already is fights the scroll in progress.
  useEffect(() => {
    if (mine.current === value) return;
    const i = Math.max(0, values.indexOf(value));
    if (ref.current) ref.current.scrollTop = i * ROW;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const i = Math.max(0, Math.min(values.length - 1, Math.round(el.scrollTop / ROW)));
      if (values[i] !== value) {
        mine.current = values[i];
        onChange(values[i]);
      }
    }, 90);
  };

  const selected = Math.max(0, values.indexOf(value));

  return (
    <div className="wheel-hold">
      <div className="wheel-rail" />
      <div className="wheel" ref={ref} onScroll={onScroll}>
        <ul>
          {values.map((v, i) => (
            <li key={String(v)} aria-selected={i === selected}>
              {render(v)}
            </li>
          ))}
        </ul>
      </div>
    </div>
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

/** A weighing scale: platform, riser, dial. */
export function Scale({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8.5 10.5 12 8l3.5 2.5" />
      <path d="M12 8v3" />
      <path d="M7 17h10" />
    </svg>
  );
}

/**
 * The fire mark, as an outline.
 *
 * Traced from the logo file rather than drawn freehand, so the proportions,
 * the three tongues and the inner curl are the real ones. One contour does
 * the whole thing: every white area in the source reaches the outside edge,
 * so tracing the silhouette and then not filling it gives the outline with
 * no cutout paths to manage. The two side arms were thickened inward by
 * about a percent of the width before tracing — inward because their outer
 * edge *is* the logo's circle, and growing that way would change the
 * silhouette.
 *
 * 1.4 rather than the 1.6 every other icon here uses. This mark packs far
 * more line into the same 24 pixels than, say, the scale, and at 1.6 the
 * inner curl closes into a blob.
 *
 * One colour. The burn screen already gives --burn-2 a specific meaning —
 * short of target — and a two-tone icon would spend it on decoration.
 */
export function Flame({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--burn)"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.11,1.43 C12.11,2.43 11.62,3.74 10.48,5.79 C9.15,8.18 8.66,9.44 8.48,10.89 C8.26,12.75 9,14.87 10.43,16.49 C10.78,16.88 10.78,16.88 10.56,16.91 C9.84,17.01 8.92,16.78 8.19,16.31 C8.02,16.2 7.43,15.61 7.43,15.55 C7.43,15.53 7.36,15.42 7.27,15.3 C7.19,15.17 7.11,15.03 7.1,14.98 C7.09,14.93 7.05,14.83 7.01,14.75 C6.8,14.36 6.53,13.4 6.48,12.92 C6.45,12.68 6.43,12.63 6.35,12.62 C6.22,12.6 6.19,12.49 6.32,12.49 C6.4,12.49 6.41,12.46 6.41,12.23 C6.41,11.43 6.62,10.83 7.4,9.26 C8.2,7.68 8.32,7.34 8.31,6.63 C8.31,6.1 8.27,5.72 8.2,5.64 C8.18,5.61 8.14,5.47 8.11,5.32 C8.07,5.18 8.03,5.05 8.01,5.05 C7.99,5.05 7.96,4.99 7.94,4.91 C7.9,4.72 7.85,4.73 7.78,4.97 C7.44,6.1 6.8,7.28 5.27,9.54 C3.56,12.06 3.07,14.26 3.69,16.65 C4.65,20.38 9.01,22.6 13.94,21.87 C18.38,21.21 20.93,18.51 20.93,14.46 C20.92,12.51 20.66,11.7 19.23,9.22 C18.01,7.11 17.33,5.45 17.33,4.66 C17.33,4.47 17.26,4.52 17.16,4.78 C17.12,4.92 17.06,5.04 17.04,5.05 C17.01,5.08 16.84,5.56 16.73,5.95 C16.36,7.28 16.52,8.59 17.34,11.15 C17.51,11.66 17.67,12.18 17.7,12.28 C17.74,12.43 17.78,12.49 17.84,12.49 C17.89,12.49 17.94,12.52 17.96,12.56 C17.98,12.6 17.95,12.63 17.88,12.63 C17.8,12.63 17.79,12.65 17.82,12.78 C17.93,13.32 17.89,14 17.69,14.63 C17.64,14.81 17.6,14.97 17.6,14.99 C17.6,15.01 17.55,15.14 17.48,15.28 C17.41,15.41 17.36,15.53 17.36,15.55 C17.36,15.57 17.23,15.74 17.07,15.93 C16.08,17.07 14.27,17.26 13.36,16.3 C12.5,15.4 12.52,13.92 13.39,13.05 C13.92,12.51 14.55,12.4 15.82,12.61 C15.98,12.64 15.98,12.64 15.95,11.89 C15.86,9.68 15.41,8.31 13.82,5.43 C12.83,3.62 12.25,2.16 12.25,1.46 C12.25,1.45 12.21,1.43 12.18,1.41 C12.14,1.4 12.11,1.41 12.11,1.43 Z" />
    </svg>
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
