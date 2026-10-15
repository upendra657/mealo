/**
 * Show working: what Ask Mealo looked up for an answer, what came back, and
 * what the app took out of what it wrote.
 *
 * Approved 15 Oct 2026 from a mock-up: the working opens in place under the
 * answer, each lookup in plain rows, with "Exactly what was sent" for the
 * text the model received word for word; off until switched on in Dev,
 * because most people asking about their dinner do not want the plumbing.
 *
 * One thing is never shown: the words of a sentence the dose filter took
 * out. Struck through, it would still put the dose on screen, which is what
 * R2 exists to prevent. It is counted and named, nothing more. A wrong
 * figure, or a claim to have saved something, is safe to show, and is.
 */

import { kvGet, kvSet } from '../lib/kv';
import type { LoopResult } from '../llm/toolloop';
import { TAG_WORDS } from './patterns';
import { toolLabel } from './tools';

export type Row = [label: string, value: string];

export type Lookup = {
  /** "Thali: meals, 7 days". */
  label: string;
  /** The tool's name, as the model called it. */
  name: string;
  rows: Row[];
  /** The message the model was sent, before R5; scrubbed for display by `asSent`. */
  sent: string;
};

export type Removed =
  | { why: 'figure'; text: string }
  | { why: 'claim'; text: string }
  /** No text, ever: see the header. */
  | { why: 'dose'; count: number };

export type Working = {
  lookups: Lookup[];
  /** Cards and sheets it put on screen, by label. They read nothing. */
  shown: string[];
  /** The model would not take tools and answered from "What it can see" alone. */
  withoutTools: boolean;
  removed: Removed[];
  requests: number;
  ms: number;
  tokens: number | null;
  model: string | null;
};

const n = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '—'));
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A lookup's result as a few rows a person can read. The figures are the
 * result's own, reworded and never recalculated: a row that worked
 * something out would be a figure the model never saw.
 */
export function rowsFor(name: string, result: unknown): Row[] {
  const r = obj(result);
  if (typeof r.error === 'string') return [['Answer', r.error]];
  switch (name) {
    case 'thali_summary': {
      const rows: Row[] = [['Days logged', `${n(r.days_logged)} of ${n(r.days_in_period)}`]];
      for (const [macro, v] of Object.entries(obj(r.average_per_logged_day))) {
        const a = obj(v);
        if (a.average == null) continue;
        const unit = typeof a.unit === 'string' ? ` ${a.unit}` : '';
        rows.push([cap(macro), `${n(a.average)}${unit} avg${a.target != null ? ` · target ${n(a.target)}${unit}` : ''}`]);
      }
      const within = obj(r.days_within_calorie_target);
      if (within.days != null) rows.push(['In calorie target', `${n(within.days)} of ${n(within.of_logged_days)} days`]);
      for (const macro of ['calories', 'protein']) {
        const top = list(obj(r.top_dishes_by_share)[macro]).slice(0, 2);
        if (top.length) rows.push([`Most ${macro} from`, top.map((d) => `${d.dish} ${n(d.percent_of_period_total)}%`).join(' · ')]);
      }
      return rows;
    }
    case 'thali_day': {
      const meals = list(r.meals);
      const t = obj(r.totals_eaten);
      return [
        ['Day', String(r.day ?? '')],
        ['Meals', meals.length ? `${meals.length} · ${meals.reduce((k, m) => k + list(m.dishes).length, 0)} dishes` : 'None logged'],
        ...(t.calories != null ? ([['Eaten', `${n(t.calories)} Cal · ${n(t.protein_g)} g protein`]] as Row[]) : []),
      ];
    }
    case 'thali_before_symptom': {
      const items = list(r.items);
      const out = items.filter((i) => i.finding === TAG_WORDS['stands-out']);
      return [
        ['Symptom', String(r.symptom ?? '')],
        ...(r.looked_back ? ([['Looked back', String(r.looked_back)]] as Row[]) : []),
        ['Bouts', `${n(r.bouts_found)}${r.over ? ` in ${r.over}` : ''}`],
        ['Stands out', out.length ? out.map((i) => String(i.food ?? i.medicine)).join(' · ') : 'Nothing'],
      ];
    }
    case 'dawa_adherence': {
      const d = obj(r.doses);
      const not = list(r.not_taken).slice(0, 2);
      return [
        ['Doses', `${n(d.taken)} taken of ${n(d.scheduled)}`],
        ['Not taken', `${n(d.missed)} missed · ${n(d.skipped)} skipped`],
        ...not.map((x): Row => ['', `${x.medicine}, ${String(x.time_of_day).toLowerCase()}`]),
      ];
    }
    case 'weight_trend':
      return [
        ['Readings', n(list(r.readings).length)],
        ...(r.change_first_to_last_kg != null ? ([['Change', `${n(r.change_first_to_last_kg)} kg`]] as Row[]) : []),
        ...(r.goal_weight_kg != null ? ([['Goal', `${n(r.goal_weight_kg)} kg`]] as Row[]) : []),
      ];
    case 'symptom_log': {
      const entries = list(r.entries);
      return [
        ['Entries', n(entries.length)],
        ['Still open', n(entries.filter((e) => e.state === 'still open').length)],
      ];
    }
    default:
      return [];
  }
}

/** Cards and sheets read nothing; they are said apart from lookups, as the note above the answer says them. */
const shows = (name: string) => name.startsWith('propose_') || name === 'prepare_report';

export function buildWorking(loop: LoopResult, removed: { figures: string[]; doses: number; claims: string[] }): Working {
  return {
    lookups: loop.runs.filter((r) => !shows(r.name)).map((r) => ({ label: toolLabel(r.name, r.args), name: r.name, rows: rowsFor(r.name, r.result), sent: r.sent })),
    shown: [...new Set(loop.runs.filter((r) => shows(r.name)).map((r) => toolLabel(r.name, r.args)))],
    withoutTools: loop.withoutTools,
    removed: [
      ...removed.figures.map((text): Removed => ({ why: 'figure', text })),
      ...(removed.doses > 0 ? [{ why: 'dose', count: removed.doses } as Removed] : []),
      ...removed.claims.map((text): Removed => ({ why: 'claim', text })),
    ],
    requests: loop.requests,
    ms: loop.ms,
    tokens: loop.tokens,
    model: loop.model,
  };
}

const KEY = 'askmealo.working';

/** Off until chosen in Dev. On this phone, for whoever uses it. */
export async function showsWorking(): Promise<boolean> {
  return (await kvGet<boolean>(KEY)) === true;
}

export async function setShowsWorking(on: boolean): Promise<void> {
  await kvSet(KEY, on);
}
