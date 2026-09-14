/**
 * Drives scripts/e2e/harness.html headlessly.
 *
 *   npm run test:e2e
 *
 * Starts `vite dev` (which supplies the COOP/COEP headers OPFS needs), opens
 * the harness, waits for it to report, prints the result and exits non-zero on
 * any failure.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.E2E_PORT || 5100 + (process.pid % 800));

/**
 * Playwright is a heavyweight dependency for a project whose whole point is
 * that it costs nothing to run, so it is not in package.json. Take it from
 * wherever it already is — a global install, or the local tree if someone
 * added it.
 */
async function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  try {
    candidates.push(require.resolve('playwright'));
  } catch { /* not local */ }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    candidates.push(`${root}/playwright/index.js`);
  } catch { /* no global npm */ }

  for (const path of candidates) {
    try {
      const mod = await import(pathToFileURL(path).href);
      return (mod.chromium ?? mod.default?.chromium);
    } catch { /* try the next */ }
  }
  throw new Error(
    'playwright not found. `npm i -g playwright` (the browser itself is already ' +
      'on this machine), or run scripts/e2e/harness.html in a browser by hand.',
  );
}

function startServer() {
  const proc = spawn(
    'npx',
    ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start in 60s')), 60_000);
    const onData = (buf) => {
      if (/Local:\s+http/.test(buf.toString())) {
        clearTimeout(timer);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(`vite exited early (${code})`)));
  });
}

const chromium = await loadChromium();
const server = await startServer();
let exitCode = 1;

try {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  // Only surface trouble — the harness prints its own report at the end.
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      console.error(`  [${m.type()}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  page.on('requestfailed', (r) =>
    console.error('  [requestfailed]', r.url(), r.failure()?.errorText),
  );

  await page.goto(`http://127.0.0.1:${PORT}/scripts/e2e/harness.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction('window.__done !== undefined', null, { timeout: 90_000 });

  const done = await page.evaluate('window.__done');
  console.log(done.text);
  exitCode = done.failed === 0 ? 0 : 1;
  await browser.close();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
} finally {
  server.kill('SIGTERM');
}

process.exit(exitCode);
