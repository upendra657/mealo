/**
 * The gate before a push. A push to main is a release (Cloudflare builds
 * every push and serves it to both phones), so nothing reaches main that
 * this has not passed. Upendra, 15 Oct 2026: "Pre-push check should always
 * be flawless."
 *
 *   npm run check            everything, against the working tree
 *   .githooks/pre-push       the same, plus the checks below on what is pushed
 *
 * Two halves.
 *
 * What is pushed must be what is tested. The suites run on the working tree,
 * so a push is refused when the tree has uncommitted changes to tracked
 * files, when the commit pushed is not the one checked out, or when a file
 * the build could reach is untracked: it passes here and is missing on
 * Cloudflare, the classic "forgot to git add". Also refused: a database or
 * CSV in the pushed commits (his food data went to a public remote once),
 * and a commit under any author email but his noreply one.
 *
 * Then every check there is, in order, stopping at the first failure:
 * types, lint errors, the production build, and all five suites. The
 * portions, safety and e2e suites run twice, the second time with the local
 * clock moved to the middle of the night (or the evening, when it is
 * already night): two bugs on 15 Oct 2026 hid until the suite happened to
 * run at 01:49. A suite counts as passed only when it reports a count above
 * zero and no failures, so one that silently ran nothing is not a pass.
 *
 * It takes a few minutes. Bypassing it (`git push --no-verify`) defeats the
 * point; if a check is wrong, fix the check.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PUSHING = process.argv.includes('--push');
const AUTHOR = '89166658+upendra657@users.noreply.github.com';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ZERO = /^0+$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function refuse(why) {
  console.error(`\n✗ Push refused: ${why}\n`);
  process.exit(1);
}

// ---------------------------------------------------------- what is pushed

if (PUSHING) {
  const head = git('rev-parse', 'HEAD');
  // git hands the hook one line per ref: local ref, local sha, remote ref, remote sha.
  const refs = existsSync('/dev/stdin') ? lines(readFileSync(0, 'utf8')).map((l) => l.split(/\s+/)) : [];
  const known = (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  for (const [, localSha, remoteRef, remoteSha] of refs) {
    if (!localSha || ZERO.test(localSha)) continue; // deleting a ref: nothing to test
    if (localSha !== head) refuse(`${remoteRef} would get ${localSha.slice(0, 7)}, but ${head.slice(0, 7)} is checked out and is what gets tested. Check out what you push.`);
    // The commits this push adds: since what the remote has, or, for a new
    // branch, since where it left main.
    let base = null;
    if (remoteSha && !ZERO.test(remoteSha)) {
      if (!known(remoteSha)) refuse(`the remote has ${remoteSha.slice(0, 7)}, which this clone has never seen. Fetch first.`);
      base = remoteSha;
    } else if (known('origin/main')) {
      base = git('merge-base', 'origin/main', localSha);
    }
    const files = lines(base ? git('diff', '--name-only', base, localSha) : git('show', '--name-only', '--format=', localSha));
    const data = files.filter((f) => /\.(csv|sqlite3?|db)$/i.test(f));
    if (data.length) refuse(`these look like data, not code, and would go to a public repo: ${data.join(', ')}`);
    const authors = [...new Set(lines(base ? git('log', '--format=%ae', `${base}..${localSha}`) : git('log', '-1', '--format=%ae', localSha)))];
    const strangers = authors.filter((a) => a !== AUTHOR);
    if (strangers.length) refuse(`commits by ${strangers.join(', ')}; every commit here is by ${AUTHOR}`);
  }
}

const dirty = lines(git('status', '--porcelain', '--untracked-files=no'));
if (PUSHING && dirty.length) {
  refuse(`uncommitted changes to tracked files, so the tests would not be testing what is pushed:\n  ${dirty.join('\n  ')}`);
}
// Anything the build or the Worker could import, sitting untracked.
const untracked = lines(git('ls-files', '--others', '--exclude-standard'))
  .filter((f) => /^(src|worker|public|migrations)\//.test(f) || /^scripts\/(?!mock\/)/.test(f) || /^[^/]+\.(ts|tsx|js|mjs|json|jsonc|html)$/.test(f));
if (PUSHING && untracked.length) {
  refuse(`files the build could reach are not committed, so they would be missing on Cloudflare:\n  ${untracked.join('\n  ')}`);
}
if (!PUSHING && (dirty.length || untracked.length)) {
  console.log(`(checking the working tree, which has uncommitted changes: ${[...dirty, ...untracked].length} files)`);
}

// --------------------------------------------------------------- the checks

const env = { ...process.env };
if (!env.CHROMIUM_PATH && existsSync(CHROME)) env.CHROMIUM_PATH = CHROME;

/**
 * A zone whose local clock now reads 01:00, or 21:00 if it is already
 * night here. Etc/GMT names have the sign reversed: Etc/GMT-5 is UTC+5.
 */
function otherHourZone() {
  const localHour = new Date().getHours();
  const want = localHour < 6 ? 21 : 1;
  let offset = (((want - new Date().getUTCHours()) % 24) + 24) % 24;
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return { zone: offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`, want };
}
const night = otherHourZone();

const suite = (name, script, extraEnv = {}) => ({ name, cmd: ['npm', 'run', script], env: extraEnv, counted: true });
const steps = [
  { name: 'types', cmd: ['npx', 'tsc', '--noEmit', '-p', 'tsconfig.app.json'] },
  // oxlint exits non-zero on errors only; its warnings are reported, not fatal.
  { name: 'lint', cmd: ['npx', 'oxlint', 'src/', 'scripts/'] },
  { name: 'build', cmd: ['npm', 'run', 'build'] },
  suite('portions', 'test:portions'),
  suite('safety', 'test:safety'),
  suite('demo relay', 'test:demo'),
  suite('e2e', 'test:e2e'),
  suite(`portions at ${String(night.want).padStart(2, '0')}:00 (${night.zone})`, 'test:portions', { TZ: night.zone }),
  suite(`safety at ${String(night.want).padStart(2, '0')}:00`, 'test:safety', { TZ: night.zone }),
  suite(`e2e at ${String(night.want).padStart(2, '0')}:00`, 'test:e2e', { TZ: night.zone }),
  suite('sync and reminder relay', 'test:relay'),
];

const results = [];
const started = Date.now();
for (const step of steps) {
  const t0 = Date.now();
  process.stdout.write(`… ${step.name}`);
  const run = spawnSync(step.cmd[0], step.cmd.slice(1), { env: { ...env, ...step.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  let ok = run.status === 0;
  let note = '';
  if (step.counted) {
    // The last "N passed, M failed" line is the suite's verdict.
    const tallies = [...out.matchAll(/(\d+) passed, (\d+) failed/g)];
    const last = tallies[tallies.length - 1];
    if (!last) {
      ok = false;
      note = 'reported no count';
    } else {
      const [passed, failed] = [Number(last[1]), Number(last[2])];
      note = `${passed} passed`;
      if (failed > 0 || passed === 0) ok = false;
      if (failed > 0) note += `, ${failed} failed`;
    }
  }
  process.stdout.write(`\r${ok ? '✓' : '✗'} ${step.name}${note ? `: ${note}` : ''} (${secs}s)\n`);
  results.push({ ...step, ok, note });
  if (!ok) {
    const failing = lines(out).filter((l) => /^\s*FAIL\b|error|Error/.test(l)).slice(0, 30);
    console.error(`\n${failing.length ? failing.join('\n') : lines(out).slice(-30).join('\n')}\n`);
    console.error(`✗ ${PUSHING ? 'Push refused' : 'Check failed'}: ${step.name}. Nothing after it was run.\n`);
    process.exit(1);
  }
}
console.log(`\nAll ${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)}s.${PUSHING ? ' Pushing.' : ''}`);
