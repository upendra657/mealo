/**
 * Requirement R5: the de-identification boundary is enforced at the adapter,
 * not at the prompt.
 *
 * Until now the slice was built clean in `domain/state.ts` and that was the
 * whole of it. Which was fine, and stayed fine only because Ask Mealo was the
 * only caller. "Composed carefully upstream" is a convention, and a convention
 * is one forgetful call site away from being nothing. A boundary is a place
 * every payload has to pass through, and there is exactly one of those: the
 * function that calls fetch.
 *
 * So this runs on the way out, on every request, and the property holds no
 * matter which caller built the payload or how carelessly.
 *
 * ---------------------------------------------------------------------------
 * Redacting rather than refusing
 * ---------------------------------------------------------------------------
 *
 * The obvious alternative is to throw, the way `ProfileScopeError` does for an
 * unfiltered read. That is right for a database query, where the caller is
 * always this codebase and a crash in development is the cheapest possible
 * teacher. It is wrong here, because the failure lands on someone mid-sentence
 * in a conversation about their own health, and a chat that dies on a
 * coincidental thirteen-digit number is a worse product than one that sends
 * `[id]`.
 *
 * Redacting gives the same guarantee — the identifier does not leave the
 * device either way — without that cost. The loudness moves to two other
 * places instead: every redaction is recorded on the outbound log entry, so
 * the verification view shows exactly what was caught, and the tests assert
 * that ordinary traffic produces *zero* redactions. A clean run is the normal
 * state; anything else means something upstream regressed, and it shows up in
 * the suite rather than in the user's face.
 *
 * ---------------------------------------------------------------------------
 * What is scrubbed, and where
 * ---------------------------------------------------------------------------
 *
 * Two classes, treated differently, because the user's own words are not the
 * app's to rewrite.
 *
 *   exact secrets   device id, household id, non-fixed profile ids. Machine
 *                   identifiers with no conversational value whatsoever.
 *                   Replaced everywhere, including in what the user typed —
 *                   if a device id ends up in a user message something has
 *                   gone badly wrong, and no answer needs it.
 *
 *   shapes & names  timestamps finer than a day, uuid-shaped strings, and the
 *                   profiles' display names. Replaced only in content this app
 *                   generated — system prompts, the state slice, the rolling
 *                   summary, prior assistant turns.
 *
 * The second class stops at the user's message on purpose. Someone typing "on
 * 2026-10-01T09:00 I felt dizzy" has chosen to say that, and rewriting it
 * would corrupt the question they asked. The requirement is that the *app*
 * does not leak identifiers, not that the user is censored to the model.
 *
 * `primary` is deliberately not treated as a secret. It is the fixed profile
 * id every install shares, so it identifies nobody, and scrubbing a common
 * English word out of every payload would mangle ordinary sentences.
 */

/** One thing that was taken out, and from where. */
export type Redaction = {
  /** Which rule caught it. */
  kind: 'secret' | 'name' | 'timestamp' | 'uuid';
  /** Index of the message it was found in. */
  message: number;
  /** The message's role, so the log reads without cross-referencing. */
  role: string;
  /** How many occurrences were replaced in that message. */
  count: number;
};

export type Identity = {
  /** Exact strings that must never leave, whatever message they turn up in. */
  secrets: readonly string[];
  /** Profile display names. Scrubbed from app-generated content only. */
  names: readonly string[];
};

export type OutboundMessage = { role: string; content: string };

/**
 * Epoch milliseconds: a bare 13-digit number.
 *
 * Every row in the database carries one, so a query result stringified into a
 * prompt would carry a per-row timestamp accurate to the millisecond — which
 * is both finer than a day and, across enough rows, a behavioural fingerprint.
 *
 * Bounded at 13 digits rather than `\d{13,}` so a longer number is left alone:
 * it is not a timestamp, and a mangled number in a sentence is worse than an
 * untouched one.
 */
const EPOCH_MS = /\b1[0-9]{12}\b/g;

/**
 * An ISO datetime carrying a time of day.
 *
 * The date half is allowed through — the state slice is built in whole days on
 * purpose and needs them. Only the clock time is the problem, so the pattern
 * requires the `T` and replaces the whole thing rather than trying to trim it,
 * since a half-rewritten timestamp reads as a bug.
 */
const ISO_DATETIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\b/g;

/** A row id: uuid, or the 32-hex fallback for engines without randomUUID. */
const UUIDISH =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/gi;

/** Regex-escape a literal, so a secret containing `.` or `-` matches itself. */
function literal(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
}

/** Replace every match, counting what was taken. */
function take(text: string, re: RegExp, to: string): [string, number] {
  let n = 0;
  const out = text.replace(re, () => {
    n++;
    return to;
  });
  return [out, n];
}

/**
 * The boundary itself. Pure: same input, same output, no clock, no database.
 *
 * `names` shorter than three characters are skipped. The default profile is
 * called "Me", and replacing that substring everywhere would turn "some" into
 * "so[name]" and every other word containing it — a scrubber that corrupts
 * ordinary English is one somebody will switch off.
 */
export function deidentify(
  messages: readonly OutboundMessage[],
  identity: Identity,
): { messages: OutboundMessage[]; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  const out = messages.map((m, i) => {
    let content = m.content;
    const note = (kind: Redaction['kind'], count: number) => {
      if (count > 0) redactions.push({ kind, message: i, role: m.role, count });
    };

    // Everywhere, including the user's own message.
    let secrets = 0;
    for (const s of identity.secrets) {
      if (!s || s.length < 8) continue; // too short to be a generated id
      const [next, n] = take(content, literal(s), '[id]');
      content = next;
      secrets += n;
    }
    note('secret', secrets);

    // App-generated content only. The user's words are theirs.
    if (m.role !== 'user') {
      let names = 0;
      for (const name of identity.names) {
        if (!name || name.trim().length < 3) continue;
        const [next, n] = take(content, literal(name.trim()), '[name]');
        content = next;
        names += n;
      }
      note('name', names);

      const [afterIso, isoN] = take(content, ISO_DATETIME, '[time]');
      content = afterIso;
      const [afterEpoch, epochN] = take(content, EPOCH_MS, '[time]');
      content = afterEpoch;
      note('timestamp', isoN + epochN);

      const [afterUuid, uuidN] = take(content, UUIDISH, '[id]');
      content = afterUuid;
      note('uuid', uuidN);
    }

    return content === m.content ? m : { ...m, content };
  });

  return { messages: out, redactions };
}

/**
 * Something a person wrote that reads as an email address.
 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * A run of digits long enough to be a phone number, single spaces or hyphens
 * allowed between them. What it is gets decided in `scrubContacts`, by
 * counting; one pattern for every way a number is written was tried and
 * could not tell "98201 55512" from "140 180 210 190".
 *
 * It refuses to start or stop inside a longer number, a decimal, or a longer
 * row of groups, so a sixteen-digit number or a long list of readings is
 * left whole rather than having ten digits taken out of its middle.
 */
const DIGIT_RUN = /(?<![\w.+]|\d[ -])\+?\d(?:[ -]?\d){7,14}(?![\w]|\.\d|[ -]\d)/g;

/**
 * Phone numbers and email addresses out of free text a person wrote, before
 * the app puts that text into something it sends.
 *
 * Run where the free text enters, not inside `deidentify` on every message,
 * and that is deliberate. The boundary also carries the app's own figures: a
 * week of calories reads "1850 1920 2010 1780", and a rule loose enough to
 * catch every phone number will sooner or later take a row of those for
 * one. A missing figure in a payload is worse than the leak it prevents is
 * likely, because the model is told the figures are exact. So the caller
 * that quotes a person's words scrubs them (today: a symptom's words, in
 * domain/symptomlabels.ts), and the figures never pass through here.
 *
 * It is also not run on the message a person is sending now. Those words are
 * theirs, for the same reason a date they typed is left alone above.
 *
 * What counts as a phone number:
 *   - anything written with a leading +, 8 to 15 digits (the E.164 limit);
 *   - otherwise 10 to 12 digits in at most three groups: "9820155512",
 *     "98201 55512", "022 2345 6789", "0 98201 55512". Four groups is how a
 *     list of readings is written, and those are kept.
 * A twelve-digit Aadhaar-style number in three groups goes too, as [phone].
 * The wrong word for it, and still the right outcome.
 *
 * Other people's names are not caught. "Dr Rao's clinic" leaves as written:
 * nothing here can tell a name from any other capitalised word, and Upendra
 * decided (11 Oct 2026) that numbers and addresses are what must not travel.
 */
export function scrubContacts(text: string): { text: string; count: number } {
  let count = 0;
  const noMail = text.replace(EMAIL, () => {
    count++;
    return '[email]';
  });
  const out = noMail.replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/\D/g, '').length;
    const groups = run.split(/[ -]/).length;
    const phone = run.startsWith('+') ? digits <= 15 : digits >= 10 && digits <= 12 && groups <= 3;
    // A date is eight digits and never reaches ten, but two dates side by
    // side do: "2026-10-01 2026-10-11" is not a number to ring.
    if (!phone || /\d{4}-\d{2}-\d{2}/.test(run)) return run;
    count++;
    return '[phone]';
  });
  return { text: out, count };
}

/** One line for the verification view. Empty when the payload was clean. */
export function describeRedactions(rs: readonly Redaction[]): string {
  if (rs.length === 0) return '';
  const total = rs.reduce((n, r) => n + r.count, 0);
  const kinds = [...new Set(rs.map((r) => r.kind))].join(', ');
  return `${total} redaction${total === 1 ? '' : 's'} (${kinds})`;
}
