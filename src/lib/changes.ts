/**
 * "The record changed", said by whatever changed it.
 *
 * Reminders have to be rebuilt when a dose is ticked, a medicine is stopped
 * or a meal is logged: a ticked dose must not ring. The writes live in the
 * domain files and the rebuild needs a browser's push manager, so neither
 * should know the other. This is the wire between them, and nothing else
 * uses it.
 *
 * A listener that throws is ignored. A reminder that could not be rebuilt
 * must never be the reason a dose failed to save.
 */

const listeners = new Set<() => void>();

export function onChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function noteChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* see the header */
    }
  }
}
