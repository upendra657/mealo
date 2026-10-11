/**
 * The chat thread as the Ask Mealo screen draws it.
 *
 * Pure, so the two things the screen must never get wrong are tested without
 * a browser: which lines carry the "AI" tag, and which do not.
 *
 * Every AI-written line is tagged, and a line the app wrote itself is not.
 * The stop message is the case that matters. It is written by
 * safety/redflags.ts before any model is called, and it is stored in
 * `messages` as an assistant row because that table's CHECK knows no other
 * role for it. Read back naively it would wear the AI tag, on the one message
 * that most needs to be believed as coming from the app.
 */

import { stopOfMessage } from '../safety/gates';
import { triage } from '../safety/redflags';
import type { StateFacts } from './state';
import type { Targets } from './targets';

export type Entry =
  /** What the person asked. */
  | { kind: 'asked'; text: string; at: number }
  /** What the model said, after the dose filter. Tagged AI. */
  | { kind: 'answer'; text: string; at: number }
  /**
   * A stop: a red flag, or one of the gates in safety/gates.ts. Written by
   * code; no model saw the message. A red flag has no title of its own and
   * is drawn as "Seek care now"; a gate carries the one it was given.
   */
  | { kind: 'stop'; text: string; at: number; title?: string };

type Stored = { role: string; content: string; created_at: number };

/**
 * Stored rows to entries.
 *
 * A reply is a stop only if the message before it trips triage today AND the
 * reply is exactly what triage says. The second half is what keeps a pattern
 * added later from relabelling an old model answer as the app's own words.
 * The cost is the other way round: reword a red flag's advice and stops saved
 * under the old wording read back as AI answers. That is the safer mistake of
 * the two, and a reason not to reword advice casually.
 */
export function entriesFrom(stored: Stored[]): Entry[] {
  const out: Entry[] = [];
  stored.forEach((m, i) => {
    if (m.role === 'user') {
      out.push({ kind: 'asked', text: m.content, at: m.created_at });
      return;
    }
    if (m.role !== 'assistant') return;
    const before = stored[i - 1];
    const flagged = before?.role === 'user' ? triage(before.content) : null;
    const stop = !!flagged && flagged.triggered && flagged.message === m.content;
    // A gate's stop is known by its words alone. Its texts are fixed and
    // long, so a model's answer cannot be one by accident, and two of the
    // gates read the record as it was then, which cannot be asked again now.
    const gated = stop ? null : stopOfMessage(m.content);
    if (gated) out.push({ kind: 'stop', text: m.content, at: m.created_at, title: gated.title });
    else out.push({ kind: stop ? 'stop' : 'answer', text: m.content, at: m.created_at });
  });
  return out;
}

// ------------------------------------------------------ the app's figures
//
// "Code works out the numbers; the AI explains them" has to be visible, not
// only true. A question about the week or the day gets the figures in a
// table, worked out here and labelled as the app's, before any model has
// answered. The model is told the table is on screen and asked to explain it
// instead of reciting it, so a number the person reads in the table can never
// be one a model made up.

export type Figure = { value: string; of: string; label: string };
export type Figures = { title: string; cells: Figure[] };

const num = (n: number | null) => (n == null ? '\u2013' : Math.round(n).toLocaleString('en-US'));

/** One nutrition cell: the figure, then its target if one is set, else its unit. */
function cell(label: string, got: number | null, target: number | null, unit: string): Figure {
  return { label, value: num(got), of: target != null ? `/ ${num(target)} ${unit}` : unit };
}

/**
 * The table for a question, or null when the question is not about a period
 * the app can sum.
 *
 * Read from the words, the way a typed report request is. It will be wrong
 * sometimes, and the cost of that is a table of true figures above an answer
 * about something else; the tools Ask Mealo is to be given replace this guess
 * with what was actually looked up.
 *
 * A question about doses gets no table yet: today's facts hold the doses
 * taken, not the ones still due, and half a table would read as all of it.
 */
export function figuresFor(
  question: string,
  facts: Pick<StateFacts, 'nutrition7d' | 'adherence7d' | 'todayTotals' | 'mealsToday'>,
  targets: Targets,
): Figures | null {
  const q = question.toLowerCase();
  if (/\b(?:dose|doses|medicine|medicines|meds|tablet|tablets)\b/.test(q)) return null;

  if (/\b(?:week|weekly|7 days|seven days|lately|recently)\b/.test(q)) {
    const n = facts.nutrition7d;
    const a = facts.adherence7d;
    const due = a.taken + a.skipped + a.missed;
    if (n.daysLogged === 0 && due === 0) return null;
    const cells = [
      cell('Calories a day', n.avgEnergy, targets.energy_kcal, 'Cal'),
      cell('Protein a day', n.avgProtein, targets.protein_g, 'g'),
      cell('Carbs a day', n.avgCarbs, targets.carbs_g, 'g'),
      cell('Fats a day', n.avgFat, targets.fat_g, 'g'),
      cell('Fibre a day', n.avgFibre, targets.fibre_g, 'g'),
      // Beside the averages on purpose: "581 Cal a day" means one thing
      // over seven logged days and another over two.
      { label: 'Days logged', value: String(n.daysLogged), of: 'of 7' },
    ];
    if (due > 0) {
      cells.push(
        { label: 'Doses taken', value: String(a.taken), of: `of ${due}` },
        { label: 'Skipped or missed', value: String(a.skipped + a.missed), of: `of ${due}` },
      );
    }
    return { title: 'Last 7 days', cells };
  }

  if (/\b(?:today|so far|eaten|ate|eat)\b/.test(q)) {
    if (facts.mealsToday.length === 0) return null;
    const t = facts.todayTotals;
    return {
      title: 'Today so far',
      cells: [
        cell('Calories', t.energy, targets.energy_kcal, 'Cal'),
        cell('Protein', t.protein, targets.protein_g, 'g'),
        cell('Carbs', t.carbs, targets.carbs_g, 'g'),
        cell('Fats', t.fat, targets.fat_g, 'g'),
        cell('Fibre', t.fibre, targets.fibre_g, 'g'),
        { label: 'Meals logged', value: String(facts.mealsToday.length), of: '' },
      ],
    };
  }
  return null;
}

/** The table as one line for the model, with the instruction that goes with it. */
export function figuresNote(f: Figures): string {
  const cells = f.cells.map((c) => `${c.label} ${c.value}${c.of ? ` ${c.of}` : ''}`).join('; ');
  return (
    `The app is showing the person this table above your answer (${f.title}): ${cells}. ` +
    'If you mention one of these figures, give it exactly as it is here.'
  );
}

// ------------------------------------------------------------- elaborate
//
// The first answer is a short summary; "Elaborate" under it asks for the
// long one. Upendra chose the summary he was first given as the base, and
// asked for the option to go further to be there the moment it arrives, so
// nobody has to type "tell me more" to get past a five-line answer and
// nobody is handed a page when a glance was wanted.

/**
 * What the button sends. An ordinary message on purpose: it goes through
 * every gate a typed one does, is stored like one, and reads back as the
 * question it was when the chat is opened again.
 */
export const ELABORATE = 'Elaborate on that';

/**
 * Whether the button belongs under the thread as it stands: the last thing
 * in it is a model's answer, and that answer was not itself an elaboration.
 * A second press would only ask for the same detail again, at the person's
 * cost.
 */
export function canElaborate(thread: readonly { kind: string; text?: string }[]): boolean {
  if (thread.length === 0 || thread[thread.length - 1].kind !== 'answer') return false;
  for (let i = thread.length - 2; i >= 0; i--) {
    if (thread[i].kind === 'asked') return thread[i].text !== ELABORATE;
  }
  return true;
}

// ------------------------------------------------------- an answer's shape
//
// Models write Markdown whether asked to or not, and the screen showed it
// raw: "**Medications**: No doses recorded." Asking the model to stop is not
// enough, because the model is whichever one the person plugged in. So the
// little of Markdown that turns up in a short answer is read here and drawn
// properly: bold, bullets, numbered lists. Everything else is left as the
// text it is. Nothing is turned into HTML; the screen builds elements from
// these blocks, so a reply cannot inject markup.

export type Span = { text: string; bold: boolean };
export type AnswerBlock =
  | { kind: 'p'; spans: Span[] }
  | { kind: 'list'; items: { depth: number; marker: string | null; spans: Span[] }[] };

/** `**bold**` and `__bold__` become bold; `*x*`, `_x_` and backticks are dropped. */
export function spansOf(line: string): Span[] {
  const out: Span[] = [];
  const plain = (t: string) => t.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2').replace(/`([^`\n]+)`/g, '$1');
  let rest = line;
  for (;;) {
    const m = /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/.exec(rest);
    if (!m) break;
    if (m.index > 0) out.push({ text: plain(rest.slice(0, m.index)), bold: false });
    out.push({ text: m[1] ?? m[2], bold: true });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push({ text: plain(rest), bold: false });
  return out;
}

export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', spans: spansOf(para.join('\n')) });
    para = [];
  };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const item = /^(\s*)(?:([-*\u2022])|(\d{1,2}[.)]))\s+(.*)$/.exec(raw);
    const head = /^\s*#{1,6}\s+(.*?)\s*#*$/.exec(raw);
    if (item) {
      flush();
      const last = blocks[blocks.length - 1];
      const list = last && last.kind === 'list' ? last : null;
      const entry = { depth: item[1].length >= 2 ? 1 : 0, marker: item[3] ?? null, spans: spansOf(item[4]) };
      if (list) list.items.push(entry);
      else blocks.push({ kind: 'list', items: [entry] });
    } else if (head) {
      flush();
      // A heading in a five-line answer is a bold line, not a title.
      blocks.push({ kind: 'p', spans: [{ text: head[1].replace(/\*\*|__/g, ''), bold: true }] });
    } else if (raw.trim() === '') {
      flush();
    } else {
      para.push(raw.trim());
    }
  }
  flush();
  return blocks;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Today · 2:14 pm", "Yesterday · 9:05 am", "8 Oct · 2:14 pm".
 *
 * Built by hand rather than with toLocaleString: the same phone showed
 * "Oct 12" in one browser and "12 Oct" in another, and a label over every
 * question should not change with the engine.
 */
export function entryTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const midnight = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  // Rounded, because a day with a clock change is 23 or 25 hours long.
  const daysAgo = Math.round((midnight(now) - midnight(at)) / 86_400_000);
  const day =
    daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day} · ${clock(at)}`;
}

/** "2:14 pm". */
export function clock(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/**
 * The questions offered on an empty chat.
 *
 * They are there to show what the thing is for, so each one must be
 * answerable from what the model is actually given today: the slice in
 * domain/state.ts (today's meals and doses, the last seven days). A question
 * it cannot answer from the record would teach the wrong scope on the first
 * screen anyone sees.
 */
export const TRY_ASKING = [
  'How has my week looked?',
  'What have I eaten today?',
  'Which doses are left today?',
] as const;

// ------------------------------------------------------------- the pills
//
// "Log a meal", "Tick my doses" and "Log a symptom" under the chat bar. None
// of them calls a model: each asks one question, shows a card of exactly what
// would be written, and writes only on a tap. The wording lives here so the
// card, its button and the receipt it leaves behind cannot drift apart.

export type Pill = 'meal' | 'doses' | 'symptom';

/** Each pill's name, and the one question it asks. */
export const PILLS: Record<Pill, { label: string; asks: string }> = {
  meal: { label: 'Log a meal', asks: 'What did you eat?' },
  doses: { label: 'Tick my doses', asks: 'Due now, or earlier today' },
  symptom: { label: 'Log a symptom', asks: 'What are you feeling?' },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A drafted meal, summed for its card.
 *
 * Only dishes found in the food table are logged from the chat. A row with no
 * match would save with no calories at all, and from a card that shows a
 * total, that reads as "counted" when it was not. The card names what it
 * could not place and logs the rest.
 */
export function mealSummary(items: { food: unknown | null; energy_kcal: number | null }[]): {
  known: number;
  unknown: number;
  kcal: number;
  /** The confirm button's words, or null when there is nothing to log. */
  action: string | null;
  hint: string | null;
} {
  const known = items.filter((i) => i.food !== null);
  const unknown = items.length - known.length;
  const kcal = Math.round(known.reduce((sum, i) => sum + (i.energy_kcal ?? 0), 0));
  const action =
    known.length === 0 ? null : unknown === 0 ? 'Log meal' : `Log ${plural(known.length, 'dish', 'dishes')}`;
  const hint =
    unknown === 0
      ? null
      : known.length === 0
        ? 'None of this is in your food table yet. Add the dish in Track meals first.'
        : `${unknown === 1 ? 'One dish is' : `${unknown} dishes are`} not in your food table and will not be logged.`;
  return { known: known.length, unknown, kcal, action, hint };
}

export function mealReceipt(slotLabel: string, dishes: number, kcal: number): string {
  return `Logged to ${slotLabel.toLowerCase()} \u00b7 ${plural(dishes, 'dish', 'dishes')} \u00b7 ${kcal.toLocaleString('en-US')} Cal`;
}

/** A symptom's receipt names its label, so a wrong one is seen while Undo is still there. */
export function symptomReceipt(label: string | null): string {
  return label ? `Saved to your symptoms · ${label}` : 'Saved to your symptoms';
}

/** What a dose's circle holds on the card, before anything is saved. */
export type Mark = 'taken' | 'skipped' | null;

/**
 * Empty, taken, skipped, empty: the same turn the Track meds circle makes,
 * so a second tap means "skipped" in both places. Every dose starts empty.
 * The card never ticks one for you (Upendra's rule: "user should tick").
 */
export function nextMark(m: Mark): Mark {
  return m === null ? 'taken' : m === 'taken' ? 'skipped' : null;
}

/** The confirm button on the doses card, or null with nothing ticked. */
export function dosesAction(marks: Mark[]): string | null {
  const n = marks.filter((m) => m !== null).length;
  if (n === 0) return null;
  return marks.some((m) => m === 'skipped') ? `Save ${plural(n, 'dose')}` : `Tick ${plural(n, 'dose')}`;
}

export function dosesReceipt(marks: Mark[]): string {
  const taken = marks.filter((m) => m === 'taken').length;
  const skipped = marks.filter((m) => m === 'skipped').length;
  if (skipped === 0) return `${plural(taken, 'dose')} ticked`;
  if (taken === 0) return `${plural(skipped, 'dose')} marked skipped`;
  return `${taken} taken, ${skipped} skipped`;
}
