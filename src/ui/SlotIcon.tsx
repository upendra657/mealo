/**
 * The six slot marks, drawn as the day goes.
 *
 * A half sun climbing out of the horizon, then the sun caught behind a cloud
 * coming in from the left, then the sun overhead, then the same cloud leaving
 * on the right, then a crescent. The last is a plain plus: whatever else you
 * ate, at whatever hour.
 *
 * Drawn rather than borrowed so the morning and evening marks are exact
 * mirrors of one another — that symmetry is what makes the arc read as a day
 * passing rather than six unrelated pictures.
 */

import type { SlotId } from '../domain/slots';

const common = {
  viewBox: '0 0 32 32',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function SlotIcon({ slot, size = 32 }: { slot: SlotId; size?: number }) {
  const props = { ...common, width: size, height: size };

  switch (slot) {
    case 'breakfast':
      return (
        <svg {...props}>
          <path d="M6 23h20" />
          <path d="M10.5 23a5.5 5.5 0 0 1 11 0" />
          <path d="M16 6v7" />
          <path d="m13 9 3-3 3 3" />
          <path d="M7 19.5 5.5 18.6" />
          <path d="M25 19.5l1.5-.9" />
        </svg>
      );

    case 'msnack':
      return (
        <svg {...props}>
          <circle cx="19" cy="13" r="5" />
          <path d="M19 5.5v1.6" />
          <path d="M26.5 13h-1.6" />
          <path d="m24.3 7.7-1.1 1.1" />
          <path d="M12.5 25h9a4 4 0 0 0 .4-8 5.2 5.2 0 0 0-9.9 1.1A3.4 3.4 0 0 0 12.5 25Z" />
        </svg>
      );

    case 'lunch':
      return (
        <svg {...props}>
          <circle cx="16" cy="16" r="6" />
          <path d="M16 4v3" />
          <path d="M16 25v3" />
          <path d="M4 16h3" />
          <path d="M25 16h3" />
          <path d="m7.8 7.8 2.1 2.1" />
          <path d="m22.1 22.1 2.1 2.1" />
          <path d="m24.2 7.8-2.1 2.1" />
          <path d="m9.9 22.1-2.1 2.1" />
        </svg>
      );

    case 'esnack':
      return (
        <svg {...props}>
          <circle cx="13" cy="13" r="5" />
          <path d="M13 5.5v1.6" />
          <path d="M5.5 13h1.6" />
          <path d="m7.7 7.7 1.1 1.1" />
          <path d="M19.5 25h-9a4 4 0 0 1-.4-8 5.2 5.2 0 0 1 9.9 1.1A3.4 3.4 0 0 1 19.5 25Z" />
        </svg>
      );

    case 'dinner':
      return (
        <svg {...props}>
          <path d="M25 19.5A10.5 10.5 0 0 1 12.5 7a10.5 10.5 0 1 0 12.5 12.5Z" />
        </svg>
      );

    case 'other':
    default:
      return (
        <svg {...props} strokeWidth={1.7}>
          <path d="M16 9v14" />
          <path d="M9 16h14" />
        </svg>
      );
  }
}
