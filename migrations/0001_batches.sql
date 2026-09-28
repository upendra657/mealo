-- The relay's whole schema.
--
-- An append-only log of opaque blobs, one log per household. The relay cannot
-- read `body` — it is AES-GCM ciphertext sealed with a key that never leaves
-- either phone — so there is nothing here to index on but the household and
-- the order things arrived in.
--
-- `seq` is the cursor both devices count from. AUTOINCREMENT rather than
-- plain rowid on purpose: rowids are reused after a delete, and the pruner
-- below deletes, so without it a device's cursor could sit above a freshly
-- issued seq and skip real batches.
CREATE TABLE IF NOT EXISTS batches (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  household TEXT    NOT NULL,   -- base32 of 16 random bytes; names the inbox
  device    TEXT    NOT NULL,   -- so a device can skip batches it wrote
  body      TEXT    NOT NULL,   -- base64 ciphertext, nonce prefixed
  at        INTEGER NOT NULL    -- ms, for pruning only
);

-- Every read is "this household, after this seq".
CREATE INDEX IF NOT EXISTS idx_batches_household ON batches(household, seq);
-- The pruner sweeps by age.
CREATE INDEX IF NOT EXISTS idx_batches_at ON batches(at);
