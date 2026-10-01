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
  /**
   * This slot's colour, at full strength. The selected mark on the dial takes
   * it; the sky below is built from it.
   *
   * The six are not six decisions — they are one ramp, a day burning down:
   *
   *   hue        49  37  27  10  255  298   falls all day, one turn at dusk
   *   lightness   72  55  52  47   36   46  falls all day, never turns back
   *   saturation  92  91  73  66   46   48  thins as the fire cools
   *
   * Across the four daylight slots both hue and lightness only ever move one
   * way, which is what makes them read as a ramp rather than as a list. The
   * one big step is evening into dinner — 115° — and it stays, because dusk
   * is the only moment a day genuinely does change colour. Lightness carries
   * you across it: 52, 47, 36, the fire visibly going out.
   *
   * `other` sits outside the fire on purpose. It is the slot that means this
   * did not belong to the day.
   *
   * Dinner is 1.9:1 against the ink, so this is a sky colour and a ring
   * colour, never an icon or a label colour — the dial's icons stay off-white
   * for that reason.
   */
  hue: string;
  sky: string;
};

export const SLOTS: readonly Slot[] = [
  {
    id: 'breakfast',
    label: 'Breakfast',
    hint: 'first thing',
    from: 0,
    hue: '#F9E076',
    sky: 'radial-gradient(120% 78% at 50% 104%, #F9E076 0%, #605110 44%, #0A0C0B 83%)',
  },
  {
    id: 'msnack',
    label: 'Morning snack',
    hint: 'mid-morning',
    from: 10,
    hue: '#F5A422',
    sky: 'radial-gradient(120% 78% at 50% 104%, #F5A422 0%, #604110 44%, #0A0C0B 83%)',
  },
  {
    id: 'lunch',
    label: 'Lunch',
    hint: 'midday',
    from: 12,
    hue: '#DE7D2C',
    sky: 'radial-gradient(120% 78% at 50% 104%, #DE7D2C 0%, #603410 44%, #0A0C0B 83%)',
  },
  {
    id: 'esnack',
    label: 'Evening snack',
    hint: 'late afternoon',
    from: 16,
    hue: '#C84429',
    sky: 'radial-gradient(120% 78% at 50% 104%, #C84429 0%, #5D2013 44%, #0A0C0B 83%)',
  },
  {
    id: 'dinner',
    label: 'Dinner',
    hint: 'evening',
    from: 19,
    hue: '#473286',
    sky: 'radial-gradient(120% 78% at 50% 104%, #473286 0%, #2B1E52 44%, #0A0C0B 83%)',
  },
  {
    id: 'other',
    label: 'Something else',
    hint: 'late night, or a meal of your own',
    from: 23,
    hue: '#AA3DAE',
    sky: 'radial-gradient(120% 78% at 50% 104%, #AA3DAE 0%, #511D53 44%, #0A0C0B 83%)',
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
