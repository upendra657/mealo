/**
 * Back up everything, and put a backup back.
 *
 * For the day the app has to be removed from a phone and added again: a new
 * Home Screen icon, a new phone, storage a browser decided to clear. One
 * button makes a file holding everything; one button, on the fresh app,
 * puts it back. What stands between those two presses is the only copy of
 * someone's records, so each button says exactly what it did:
 *
 *   - the backup is opened and counted before it is handed over, and the
 *     counts are shown, so "is it all in there?" has an answer on screen;
 *   - a file chosen for restore is opened and counted too, and shown beside
 *     what the phone holds now, before anything is replaced;
 *   - the restore itself keeps a copy of what was here first, and puts it
 *     back if anything goes wrong (db/worker.ts).
 *
 * The rules a file must pass are in db/backup.ts.
 *
 * Since 15 Oct 2026 this is the "This phone" card at the top of Dev: when
 * the last backup was, what is stored and which build is running (what the
 * status lines above the old screen said, in words), and the copies the app
 * keeps inside the phone by itself, weekly and before each update.
 */

import { useEffect, useRef, useState } from 'react';
import { describe, refusal, sizeLabel, type BackupInfo } from '../db/backup';
import { describeDatabase, initDb, inspectBackup, restoreBackup, saveFile, type DbInfo } from '../db/client';
import { LATEST_VERSION } from '../db/migrations';
import { listCopies, snapshotFile, type Snapshot } from '../db/snapshots';
import { localDayKey } from '../domain/day';
import { ago, BACKUP_NUDGE_DAYS, daysSince, lastBackupAt } from '../domain/upkeep';
import { backUpEverything, type Made } from './backupfile';
import { checkPersisted, formatBytes, requestPersist, type PersistState } from '../lib/persist';

declare const __BUILD_STAMP__: string;

type Chosen = { name: string; file: BackupInfo; now: BackupInfo; refused: string | null };

/**
 * Hand the file to the person. On a phone that means the share sheet, which
 * is the one route to "Save to Files" that works for an app on the Home
 * Screen; a plain download there can open the file in a viewer and save
 * nothing. Everywhere else it is an ordinary download.
 */
/** Named for what it holds and the local day, so a file in Downloads says which it is unopened. */
async function saveCopy(c: Snapshot): Promise<void> {
  const file = await snapshotFile(c);
  const day = localDayKey(c.takenAt);
  saveFile(file, c.kind === 'weekly' ? `mealo-weekly-${day}.sqlite3` : `mealo-before-v${c.version + 1}-${day}.sqlite3`);
}

const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function Counts({ info }: { info: BackupInfo }) {
  return (
    <ul className="bk-counts">
      {describe(info).map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export function BackupCard() {
  const [busy, setBusy] = useState<null | 'backup' | 'reading' | 'restoring'>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [db, setDb] = useState<DbInfo | null>(null);
  const [storage, setStorage] = useState<PersistState | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const [copies, setCopies] = useState<Snapshot[]>([]);
  const [showCopies, setShowCopies] = useState(false);
  const [now] = useState(() => Date.now());
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void initDb().then((d) => live && setDb(d));
    // Asking on every visit is fine: a browser that granted it answers at
    // once, and one that refused does not ask the person again.
    void requestPersist()
      .catch(() => checkPersisted())
      .then((p) => live && setStorage(p));
    void lastBackupAt().then((t) => live && setLast(t));
    void listCopies()
      .then((c) => live && setCopies(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const say = (e: unknown) => setProblem(e instanceof Error ? e.message : String(e));

  const backUp = async () => {
    setBusy('backup');
    setProblem(null);
    setMade(null);
    try {
      const got = await backUpEverything();
      if (got === 'cancelled') setProblem('The backup was made but not saved: the share sheet was closed. Press Back up everything again and choose Save to Files.');
      else {
        setMade(got);
        setLast(Date.now());
      }
    } catch (e) {
      say(e);
    } finally {
      setBusy(null);
    }
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setBusy('reading');
    setProblem(null);
    setChosen(null);
    try {
      const info = await inspectBackup(file);
      setChosen({ name: file.name, file: info, now: await describeDatabase(), refused: refusal(info, LATEST_VERSION) });
    } catch (e) {
      say(e);
    } finally {
      setBusy(null);
      // The same file can be chosen again after a refusal.
      if (picker.current) picker.current.value = '';
    }
  };

  const restore = async () => {
    setBusy('restoring');
    setProblem(null);
    try {
      await restoreBackup();
      setDone(true);
      // Every screen holds figures read from the database that was just
      // replaced. Starting again is the only honest way to show the new one.
      setTimeout(() => location.reload(), 1400);
    } catch (e) {
      say(e);
      setBusy(null);
    }
  };

  const stale = last === null || daysSince(last, now) >= BACKUP_NUDGE_DAYS;

  return (
    <section className="card bk">
      {db && db.mode !== 'opfs' && (
        <div className="dv-state" data-tone="warn" style={{ marginTop: 0, marginBottom: 12 }}>
          <b>Not kept on disk.</b> This browser is holding Mealo in memory, and everything is lost on reload. The page needs its isolation
          headers (COOP and COEP).
        </div>
      )}
      {db?.snapshot.status === 'failed' && (
        <div className="dv-state" data-tone="warn" style={{ marginTop: 0, marginBottom: 12 }}>
          <b>No copy was kept before this update.</b> {db.snapshot.error}
        </div>
      )}
      <div className="dv-kv">
        <span className="k">Last backup</span>
        <span className="v" data-tone={stale ? 'warn' : undefined}>
          {last === null ? 'none from this phone yet' : ago(last, now)}
        </span>
      </div>
      <div className="dv-kv">
        <span className="k">Saved</span>
        <span className="v">
          {storage?.usage !== undefined ? `${formatBytes(storage.usage)}, ` : ''}on this phone only
          {storage && !storage.persisted && (
            <span className="small" style={{ display: 'block', color: 'var(--warn)' }}>
              the browser may clear it if space runs low
            </span>
          )}
        </span>
      </div>
      <div className="dv-kv">
        <span className="k">Version</span>
        <span className="v">
          {db ? `v${db.version} · ` : ''}built {__BUILD_STAMP__}
        </span>
      </div>

      <button className="bk-btn bk-btn--go" disabled={busy !== null} onClick={() => void backUp()}>
        {busy === 'backup' ? 'Making the backup…' : 'Back up everything'}
      </button>
      {made && (
        <div className="bk-box" data-tone="ok">
          <strong>
            Backup made · {made.name} · {sizeLabel(made.info.bytes)}
          </strong>
          <p>The app opened the file and counted what is in it:</p>
          <Counts info={made.info} />
          <p>
            {made.how === 'shared' ? 'Check it is where you saved it' : 'Check it is in your Downloads'}, at about {sizeLabel(made.info.bytes)}, before
            you remove the app. Not in a backup: your model provider and its key, and the pairing with another phone. Set those up again
            afterwards.
          </p>
        </div>
      )}

      <input
        ref={picker}
        type="file"
        className="bk-file"
        aria-label="Choose a backup file"
        onChange={(e) => void choose(e.target.files?.[0])}
      />
      <div className="dv-two">
        <button className="bk-btn" disabled={busy !== null || done} onClick={() => picker.current?.click()}>
          {busy === 'reading' ? 'Reading…' : 'Restore a backup'}
        </button>
        <button className="bk-btn" aria-expanded={showCopies} onClick={() => setShowCopies((v) => !v)}>
          Copies kept · {copies.length}
        </button>
      </div>
      <p className="muted small" style={{ margin: '10px 0 0' }}>
        One file with everything: meals, your food table, medicines and doses, weight, symptoms, the chat, every profile. Save it to Files or
        iCloud Drive; it does not leave the phone any other way. Restoring shows what a file holds first, and keeps a copy of what is here
        before anything is replaced.
      </p>

      {showCopies && (
        <div className="bk-box">
          {copies.length === 0 && <p>None yet. The first weekly copy is taken the next time Mealo starts.</p>}
          {copies.map((c) => (
            <div className="dv-copy" key={c.name}>
              <span className="grow">
                {c.kind === 'weekly' ? 'Weekly copy' : `Before the v${c.version + 1} update`}
                <span className="amt">
                  {shortDate(c.takenAt)} · {formatBytes(c.bytes)}
                </span>
              </span>
              <button className="link" onClick={() => void saveCopy(c)}>
                Save
              </button>
            </div>
          ))}
          <p className="small muted" style={{ marginTop: 8 }}>
            Kept inside the app by itself: one a week, two weeks back, and one before each update changes how the data is laid out. They
            protect against a fault in the app, not against losing the phone. To put one back, save it, then Restore a backup.
          </p>
        </div>
      )}

      {chosen && !done && (
        <div className="bk-box" data-tone={chosen.refused ? 'bad' : 'warn'}>
          <strong>
            {chosen.name} · {sizeLabel(chosen.file.bytes)}
          </strong>
          {chosen.refused ? (
            <p>{chosen.refused} Nothing on this phone was changed.</p>
          ) : (
            <>
              <div className="bk-two">
                <div>
                  <div className="bk-two-h">In the file</div>
                  <Counts info={chosen.file} />
                </div>
                <div>
                  <div className="bk-two-h">On this phone now</div>
                  <Counts info={chosen.now} />
                </div>
              </div>
              <p>
                Restoring replaces <b>everything on this phone</b> with what is in the file. Anything logged here since that backup was made
                will be gone.
              </p>
              <div className="bk-row">
                <button className="bk-btn" disabled={busy !== null} onClick={() => setChosen(null)}>
                  Cancel
                </button>
                <button className="bk-btn bk-btn--warn" disabled={busy !== null} onClick={() => void restore()}>
                  {busy === 'restoring' ? 'Restoring…' : 'Replace with this backup'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {done && (
        <div className="bk-box" data-tone="ok">
          <strong>Restored.</strong>
          <p>Every row in the file is now on this phone. Reloading…</p>
        </div>
      )}
      {problem && (
        <div className="bk-box" data-tone="bad" role="alert">
          <p>{problem}</p>
        </div>
      )}
    </section>
  );
}
