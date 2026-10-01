/**
 * Requirement R5: the de-identification boundary is enforced at the adapter,
 * not at the prompt.
 *
 * Until now the slice was built clean in `domain/state.ts` and that was the
 * whole of it. Which was fine, and stayed fine only because the Doctor was the
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

/** One line for the verification view. Empty when the payload was clean. */
export function describeRedactions(rs: readonly Redaction[]): string {
  if (rs.length === 0) return '';
  const total = rs.reduce((n, r) => n + r.count, 0);
  const kinds = [...new Set(rs.map((r) => r.kind))].join(', ');
  return `${total} redaction${total === 1 ? '' : 's'} (${kinds})`;
}
