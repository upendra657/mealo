import { useEffect, useState } from 'react';
import { initDb, type DbInfo } from '../db/client';
import {
  checkPersisted,
  formatBytes,
  requestPersist,
  type PersistState,
} from '../lib/persist';

declare const __BUILD_STAMP__: string;

export function StatusBar() {
  const [db, setDb] = useState<DbInfo | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [storage, setStorage] = useState<PersistState | null>(null);

  useEffect(() => {
    initDb().then(setDb).catch((e: Error) => setDbError(e.message));
    // Asking on every start is fine: browsers that granted it answer
    // immediately, and ones that refuse do not re-prompt.
    requestPersist().then(setStorage).catch(() => {
      checkPersisted().then(setStorage);
    });
  }, []);

  return (
    <div className="status">
      <span>
        <b>Storage</b>{' '}
        {db ? (
          db.mode === 'opfs' ? (
            <span className="ok">OPFS · schema v{db.version}</span>
          ) : (
            <span className="warn">
              in-memory — data is lost on reload (needs COOP/COEP)
            </span>
          )
        ) : dbError ? (
          <span className="bad">{dbError}</span>
        ) : (
          '…'
        )}
      </span>
      <span>
        <b>Durability</b>{' '}
        {storage ? (
          storage.persisted ? (
            <span className="ok">persistent</span>
          ) : (
            <span className="warn">evictable — export regularly</span>
          )
        ) : (
          '…'
        )}
      </span>
      {storage?.usage !== undefined && (
        <span className="muted">
          {formatBytes(storage.usage)} / {formatBytes(storage.quota)}
        </span>
      )}
      <span className="muted" title="Which build is running. PWAs cache hard.">
        <b>Build</b> {__BUILD_STAMP__}
      </span>
    </div>
  );
}
