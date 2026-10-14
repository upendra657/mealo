/**
 * Making a backup file and handing it over: the share sheet on a phone, a
 * download elsewhere. Its own module so Dev's This phone card and the Home
 * nudge make a backup the same way, and both count it (domain/upkeep.ts).
 */

import type { BackupInfo } from '../db/backup';
import { makeBackup, saveFile } from '../db/client';
import { noteBackup } from '../domain/upkeep';

export type Made = { name: string; info: BackupInfo; how: 'shared' | 'downloaded' };

export async function hand(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (phone && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (e) {
      // Closing the sheet is not a failure, and must not be reported as a
      // backup that was saved.
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  saveFile(file, file.name);
  return 'downloaded';
}

/**
 * Make a backup and hand it over, and note when it was saved. Shared with
 * the Home nudge, so a backup made from either place counts the same.
 */
export async function backUpEverything(): Promise<Made | 'cancelled'> {
  const { file, info } = await makeBackup();
  const how = await hand(file);
  if (how === 'cancelled') return 'cancelled';
  await noteBackup();
  return { name: file.name, info, how };
}

