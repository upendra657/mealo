/**
 * The six parts of a day.
 *
 * Five named slots plus one for anything else — a late dinner, something at
 * 2am, a meal that doesn't fit. The order here is the order they sit on the
 * dial, left to right, which is also the order of the day.
 *
 * `icon` names the drawing in ui/SlotIcon.tsx; `sky` is the background wash
 * the selector cross-fades through as the dial turns. Both live here so the
 * dial and the day screen can never disagree about what breakfast looks like.
 */

export type SlotId =
  | 'breakfast'
  | 'msnack'
  | 'lunch'
  | 'esnack'
  | 'dinner'
  | 'other';

export type Slot = {
  id: SlotId;
  label: string;
  /** The half-sentence under the title on the selector. */
  hint: string;
  /** Hour this slot starts, used only to guess a default. */
  from: number;
  sky: string;
};

export const SLOTS: readonly Slot[] = [
  {
    id: 'breakfast',
    label: 'Breakfast',
    hint: 'first thing',
    from: 0,
    sky: 'radial-gradient(120% 78% at 50% 104%, #58341C 0%, #2A2338 42%, #0A0C0B 82%)',
  },
  {
    id: 'msnack',
    label: 'Morning snack',
    hint: 'mid-morning',
    from: 10,
    sky: 'radial-gradient(120% 78% at 50% 104%, #3D4A63 0%, #23314A 44%, #0A0C0B 82%)',
  },
  {
    id: 'lunch',
    label: 'Lunch',
    hint: 'midday',
    from: 12,
    sky: 'radial-gradient(120% 78% at 50% 104%, #1D6C86 0%, #123A52 44%, #0A0C0B 82%)',
  },
  {
    id: 'esnack',
    label: 'Evening snack',
    hint: 'late afternoon',
    from: 16,
    sky: 'radial-gradient(120% 78% at 50% 104%, #7A3C2C 0%, #3A2438 44%, #0A0C0B 82%)',
  },
  {
    id: 'dinner',
    label: 'Dinner',
    hint: 'evening',
    from: 19,
    sky: 'radial-gradient(120% 78% at 50% 104%, #1C2450 0%, #10152C 44%, #0A0C0B 84%)',
  },
  {
    id: 'other',
    label: 'Something else',
    hint: 'late night, or a meal of your own',
    from: 23,
    sky: 'radial-gradient(120% 78% at 50% 104%, #223029 0%, #151B18 44%, #0A0C0B 84%)',
  },
];

export function slot(id: string | null | undefined): Slot {
  return SLOTS.find((s) => s.id === id) ?? SLOTS[0];
}

/** Which slot the clock suggests. A starting point, always overridable. */
export function guessSlot(d = new Date()): SlotId {
  const h = d.getHours();
  if (h < 10) return 'breakfast';
  if (h < 12) return 'msnack';
  if (h < 16) return 'lunch';
  if (h < 19) return 'esnack';
  if (h < 23) return 'dinner';
  return 'other';
}

/**
 * Meals logged before the six slots existed used breakfast/lunch/dinner/snack.
 * Rather than migrate the rows — a meal's slot is a label, not a fact worth
 * rewriting — old values are read through this.
 */
export function normaliseSlot(stored: string | null): SlotId {
  if (!stored) return 'other';
  if (SLOTS.some((s) => s.id === stored)) return stored as SlotId;
  if (stored === 'snack') return 'esnack';
  return 'other';
}
