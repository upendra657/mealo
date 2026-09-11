/**
 * Copy the sqlite-wasm distribution into public/ so Vite serves it verbatim.
 *
 * Why this exists: SQLite's OPFS backend spawns its own async proxy worker
 * (sqlite3-opfs-async-proxy.js) and locates it relative to the module that
 * loaded it. When the package is bundled, that path resolution breaks under
 * `vite dev` — the proxy worker fails to load, the OPFS VFS silently refuses to
 * install, and the app falls back to an in-memory database that loses
 * everything on reload. Which, for a health log, is the worst available failure.
 *
 * Serving the whole dist directory from a fixed URL makes dev and production
 * behave identically. Run automatically by predev/prebuild.
 */

import { cp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@sqlite.org/sqlite-wasm/dist');
const dest = resolve(root, 'public/sqlite-wasm');

if (!existsSync(src)) {
  console.error(
    `[sqlite] ${src} not found — run npm install before dev or build.`,
  );
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

console.log('[sqlite] copied wasm distribution to public/sqlite-wasm');
