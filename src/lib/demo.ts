/**
 * Whether this build is the public demo.
 *
 * The demo is the same app at its own address, opened by strangers, showing
 * a made-up person so that every screen has something on it. It is a build,
 * not a setting: `npm run build:demo` sets the flag at build time, so the
 * real app cannot be switched into it and the demo's person is not even in
 * the real app's bundle.
 *
 * What the flag changes, all of it: a made-up person is written into an
 * empty database on first open (`demo/seed.ts`); and sync and reminders are
 * off, because the demo has no relay and a stranger's browser has no business
 * being paired with anything. Nothing on screen marks it as the demo: the
 * line across the top that said so was taken out at Upendra's word on
 * 12 Oct 2026, so only the address and the installed app's name ("Mealo
 * demo") tell the two apart. Ask Mealo answers through a shared key that is
 * not in the build: it sits behind the demo's relay (`worker/demo-ai.js`),
 * and a visitor can switch to a key of their own.
 */
// `typeof` first, for the test scripts: they are bundled by esbuild, which
// defines nothing, and a bare `__DEMO__` there is a ReferenceError the moment
// anything that imports this file is loaded. Vite still sees a literal, so
// the real build folds this to `false` and drops what hangs off it.
export const DEMO: boolean = typeof __DEMO__ !== 'undefined' && __DEMO__;
