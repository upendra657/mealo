/**
 * "Generate a report": the sheet that asks what, for how long and for whom,
 * and the card the finished report leaves in the chat.
 *
 * One sheet for both ways in. The pill opens it at its defaults; a typed
 * request ("my food report for the past 3 weeks") opens the same sheet
 * already filled in. Either way the person sees the real dates and presses
 * the button, so the app never acts on its own reading of "past 3 weeks".
 *
 * "For human" is drawn and switched off until that report exists. Hiding it
 * would have the sheet change shape the day it arrives; a choice that is
 * visibly not ready yet is the more honest picture of what is coming.
 */

import { useState } from 'react';
import { saveFile } from '../db/client';
import { entryTime } from '../domain/chat';
import {
  buildExport,
  collectExport,
  fileName,
  MAX_DAYS,
  MIN_DAYS,
  periodDays,
  periodLabel,
  scopeHolds,
  SCOPES,
  type Scope,
} from '../domain/export';
import { localDayKey } from '../domain/day';
import { Sheet } from './bits';

export type Report = { scope: Scope; days: string[]; name: string; text: string };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
export const FileIcon = ({ size = 20 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} {...stroke}>
    <path d="M7 3h7l4 4v14H7z" />
    <path d="M14 3v4h4" />
  </svg>
);
const PersonIcon = () => (
  <svg viewBox="0 0 24 24" width={20} height={20} {...stroke}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5" />
  </svg>
);

export function ReportSheet({
  open,
  scope,
  days,
  onScope,
  onDays,
  onClose,
  onMade,
}: {
  open: boolean;
  scope: Scope;
  days: number;
  onScope: (s: Scope) => void;
  onDays: (n: number) => void;
  onClose: () => void;
  onMade: (r: Report) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [today] = useState(() => localDayKey(Date.now()));
  const span = periodDays(days, today);
  const pct = ((days - MIN_DAYS) / (MAX_DAYS - MIN_DAYS)) * 100;

  return (
    <Sheet open={open} onClose={onClose} label="Generate a report">
      <div className="am-sh-t">Generate a report</div>

      <div className="am-eyeb am-sh-l">What</div>
      <div className="am-seg">
        {SCOPES.map((s) => (
          <button key={s.id} aria-pressed={scope === s.id} onClick={() => onScope(s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="am-eyeb am-sh-l">Period</div>
      <div className="am-per">
        <span className="am-per-n num">
          {days} <small>{days === 1 ? 'day' : 'days'}</small>
        </span>
        <span className="am-per-d">{periodLabel(span)}</span>
      </div>
      <input
        className="am-range"
        type="range"
        min={MIN_DAYS}
        max={MAX_DAYS}
        step={1}
        value={days}
        aria-label="Days in the report"
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onDays(Number(e.target.value))}
      />
      <div className="am-ticks num">
        <span>1</span>
        <span>30</span>
        <span>60</span>
        <span>90</span>
      </div>

      <div className="am-eyeb am-sh-l">For</div>
      <div className="am-opts">
        <div className="am-opt" aria-disabled="true">
          <PersonIcon />
          <div className="am-opt-t">
            For human <span className="am-soon">Soon</span>
          </div>
          <div className="am-opt-d">Charts and figures to read. Prints to PDF.</div>
        </div>
        <div className="am-opt" data-on="1">
          <FileIcon />
          <div className="am-opt-t">For AI</div>
          <div className="am-opt-d">A text file to give to another AI.</div>
        </div>
      </div>

      <p className="am-sh-n am-sh-n--warn">
        Once downloaded, the file is outside Mealo&rsquo;s protection. Your name is left out.
      </p>
      {failed && <p className="am-sh-n bad-text">{failed}</p>}

      <button
        className="am-btn am-btn--go am-sh-go"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(null);
          try {
            const input = await collectExport(scope, days);
            onMade({ scope, days: input.days, name: fileName(scope, input.days), text: buildExport(input) });
          } catch (e) {
            setFailed(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Reading your records…' : 'Create file'}
      </button>
    </Sheet>
  );
}

/** A finished report, in the thread. Lasts for the visit, like every card. */
export function ReportCard({ at, report }: { at: number; report: Report }) {
  const [preview, setPreview] = useState(false);
  const label = SCOPES.find((s) => s.id === report.scope)!.label;
  // Bytes, not characters: the file is full of "·" and "×", and the size a
  // person sees should be the size the download turns out to be.
  const kb = Math.max(1, Math.round(new Blob([report.text]).size / 1024));
  return (
    <div className="am-entry">
      <div className="am-q">
        <div className="am-q-t">{entryTime(at)} · Generate a report</div>
        <div className="am-q-x">
          {label} · {report.days.length} {report.days.length === 1 ? 'day' : 'days'} · for AI
        </div>
      </div>
      <div className="am-eyeb am-eyeb--file">
        <i />
        File for another AI · {periodLabel(report.days)}
      </div>
      <div className="am-card am-card--file">
        <div className="am-file">
          <div className="am-file-i">
            <FileIcon />
          </div>
          <div>
            <div className="am-file-n">{report.name}</div>
            <div className="am-file-d">
              {scopeHolds(report.scope)} · {kb} KB · name left out
            </div>
          </div>
        </div>
        {preview && <pre className="am-file-pre">{report.text}</pre>}
        <div className="am-btns">
          <button className="am-btn" onClick={() => setPreview((v) => !v)}>
            {preview ? 'Hide' : 'Preview'}
          </button>
          <button
            className="am-btn am-btn--go"
            onClick={() => saveFile(new Blob([report.text], { type: 'text/markdown;charset=utf-8' }), report.name)}
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
