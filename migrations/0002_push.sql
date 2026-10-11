-- When to ring a phone. Nothing about why.
--
-- Run once against the real database:
--   npx wrangler d1 execute mealo-sync --remote --file=migrations/0002_push.sql
-- The Worker also creates this table itself the first time a phone turns
-- reminders on, so a deploy that reaches production before this file is run
-- does not break anything; the file is the record of the schema and what the
-- relay test loads.
--
-- A row is one moment at which one browser should be sent an empty push.
-- `endpoint` is the address the browser's own push service gave it: a long
-- random URL at Apple, Google or Mozilla that means nothing except "this
-- browser". There is no medicine, no meal, no person and no household here,
-- and no column where one could be put. What a reminder says is written on
-- the phone, by the service worker, from a note the app left itself.
--
-- The times are still something: a row at 08:00 and one at 21:00 every day
-- says somebody is reminded of something twice a day. That is the whole of
-- what the relay learns, and the settings screen says so.
CREATE TABLE IF NOT EXISTS push_rings (
  endpoint TEXT    NOT NULL,
  -- ms since the epoch, on the minute.
  at       INTEGER NOT NULL,
  PRIMARY KEY (endpoint, at)
);

-- The cron asks "what is due" once a minute; without this it reads the table.
CREATE INDEX IF NOT EXISTS idx_push_rings_at ON push_rings(at);
