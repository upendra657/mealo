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
 * empty database on first open (`demo/seed.ts`); a line across the top of
 * every screen says the data is made up; and sync and reminders are off,
 * because the demo has no relay and a stranger's browser has no business
 * being paired with anything. Ask Mealo works with the visitor's own key or
 * not at all: nobody's key is in a public build.
 */
export const DEMO: boolean = __DEMO__;
