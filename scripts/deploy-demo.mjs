/**
 * Put the demo on Cloudflare Pages.
 *
 *   npm run deploy:demo
 *
 * Builds the demo, then uploads it from a folder outside this repository.
 *
 * Outside, because of what wrangler does inside. Run from here, wrangler
 * finds `wrangler.jsonc`, which is the real app's: its relay, its database
 * binding, its cron. `wrangler pages dev` run from this folder on 11 Oct 2026
 * served the real build in place of the demo and opened a connection to the
 * real relay database with the saved login. `pages deploy` is written to
 * ignore a Worker's config, and says so in a warning, but "is written to" is
 * not something to rest the real app's database on. From a folder with no
 * config anywhere above it there is nothing to find, so the demo goes up as
 * what it is: static files and one relay with one secret.
 *
 * The project has to exist first, once:
 *   npx wrangler pages project create mealo-demo --production-branch main
 * and the shared key is set once, by whoever runs the demo, never from here:
 *   npx wrangler pages secret put AI_KEY --project-name mealo-demo
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = process.argv[2] ?? 'mealo-demo';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

execFileSync(npm, ['run', 'build:demo'], { cwd: root, stdio: 'inherit' });

const built = join(root, 'dist-demo');
for (const needed of ['index.html', '_headers', '_worker.js', '_routes.json']) {
  if (!existsSync(join(built, needed))) {
    console.error(`dist-demo/${needed} is missing; not deploying a demo without it.`);
    process.exit(1);
  }
}

const away = mkdtempSync(join(tmpdir(), 'mealo-demo-'));
try {
  cpSync(built, join(away, 'site'), { recursive: true });
  // The pinned wrangler, by its path: `npx` from the other folder would fetch
  // whichever version is newest.
  execFileSync(join(root, 'node_modules', '.bin', 'wrangler'),
    ['pages', 'deploy', 'site', '--project-name', project, '--branch', 'main', '--commit-dirty=true'],
    { cwd: away, stdio: 'inherit' });
} finally {
  rmSync(away, { recursive: true, force: true });
}
