/**
 * "Last backup 12 days ago · Back up", on Home, below the banner.
 *
 * Everything a person logs lives on their phone and nowhere else; a backup
 * is the only way back from a lost phone or cleared data, and nobody opens
 * Dev to check when they last made one. So once it has been
 * BACKUP_NUDGE_DAYS (his 7, 15 Oct 2026) the ask comes to where he looks,
 * and the button makes the backup there, the same way Dev does. Not on a
 * phone with nothing logged, and not in the demo, whose data is made up.
 */

import { useEffect, useState } from 'react';
import { DEMO } from '../lib/demo';
import { profileCounts } from '../profiles/store';
import { ago, backupDue, lastBackupAt } from '../domain/upkeep';
import { backUpEverything } from './backupfile';
import { useToast } from './bits';

export function BackupNudge() {
  const [last, setLast] = useState<number | null | undefined>(undefined);
  const [has, setHas] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Date.now());
  const toast = useToast();

  useEffect(() => {
    if (DEMO) return;
    let live = true;
    void Promise.all([lastBackupAt(), profileCounts()]).then(([t, counts]) => {
      if (!live) return;
      setLast(t);
      setHas([...counts.values()].some((c) => c.meals > 0 || c.meds > 0));
    });
    return () => {
      live = false;
    };
  }, []);

  if (DEMO || last === undefined || !backupDue(last, now, has)) return null;

  return (
    <button
      className="nudge"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const got = await backUpEverything();
          if (got === 'cancelled') toast('Not saved: the share sheet was closed.');
          else {
            setLast(Date.now());
            toast('Backup saved.');
          }
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="grow">
        <b>{last === null ? 'No backup from this phone yet' : `Last backup ${ago(last, now)}`}</b>
        <span>Everything is on this phone only. Back up to Files or iCloud Drive.</span>
      </span>
      <span className="go">{busy ? 'Saving…' : 'Back up'}</span>
    </button>
  );
}
