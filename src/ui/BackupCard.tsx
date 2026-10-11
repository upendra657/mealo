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
 */

import { useRef, useState } from 'react';
import { describe, refusal, sizeLabel, type BackupInfo } from '../db/backup';
import { describeDatabase, inspectBackup, makeBackup, restoreBackup, saveFile } from '../db/client';
import { LATEST_VERSION } from '../db/migrations';

type Made = { name: string; info: BackupInfo; how: 'shared' | 'downloaded' };
type Chosen = { name: string; file: BackupInfo; now: BackupInfo; refused: string | null };

/**
 * Hand the file to the person. On a phone that means the share sheet, which
 * is the one route to "Save to Files" that works for an app on the Home
 * Screen; a plain download there can open the file in a viewer and save
 * nothing. Everywhere else it is an ordinary download.
 */
async function hand(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
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
  const picker = useRef<HTMLInputElement>(null);

  const say = (e: unknown) => setProblem(e instanceof Error ? e.message : String(e));

  const backUp = async () => {
    setBusy('backup');
    setProblem(null);
    setMade(null);
    try {
      const { file, info } = await makeBackup();
      const how = await hand(file);
      if (how === 'cancelled') setProblem('The backup was made but not saved: the share sheet was closed. Press Back up everything again and choose Save to Files.');
      else setMade({ name: file.name, info, how });
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

  return (
    <section className="card bk">
      <h2>Your data</h2>
      <p className="muted small">
        Everything you log lives on this phone and nowhere else. A backup is one file holding all of it: meals, your food table, medicines and
        doses, weight, symptoms, the chat, every profile.
      </p>

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

      <h3 className="bk-h">Restore</h3>
      <p className="muted small">
        Puts a backup in place of what is on this phone. You are shown what the file holds first, and a copy of what is here now is kept
        before anything is replaced.
      </p>
      <input
        ref={picker}
        type="file"
        className="bk-file"
        aria-label="Choose a backup file"
        onChange={(e) => void choose(e.target.files?.[0])}
      />
      <button className="bk-btn" disabled={busy !== null || done} onClick={() => picker.current?.click()}>
        {busy === 'reading' ? 'Reading the file…' : 'Restore from a backup'}
      </button>

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
