# AGENTS.md — instructions for AI coding agents working on this repository

You are implementing **Harness Pet**, an unofficial community pet for
DeepSeek Harness, as a native DSH web plugin (NOT a browser extension).

## Read first

1. `SPEC.md` — the authoritative spec (statuses, UI, settings, privacy, tests,
   acceptance criteria).
2. `README.md` § *State detection* and § *Porting notes (0.2.1)* — the current
   DSH contracts this fork reads, and exactly what changed from upstream.
3. `RESEARCH.md` — historical reconnaissance from the 0.1.0-rc.6 era. Its
   harness-API sections are **superseded**; use it only for the plugin-loading
   mechanics that still hold.

**Target runtime: DeepSeek Harness `0.2.1-rc.3`.** Upstream targeted
`0.1.0-rc.6` and does not load on current Harness.

## Hard constraints

- This is an **unofficial community project**, and a fork of
  [`cakeni/harness-pet`](https://github.com/cakeni/harness-pet). Keep both the
  upstream attribution and the disclaimer in README, package.json `description`,
  and UI footer:
  "This is an unofficial community project. Not affiliated with, endorsed by,
  or maintained by DeepSeek."
- **Never modify DeepSeek Harness itself.** Only files inside this repo (plus the
  user's profile install step via `dsh plugin`, which is normal usage).
- **Never reintroduce a `@deepseek-ai/dsh-client-runtime` dependency.** That
  package no longer exists; it blocks the install gate.
- **Keep `tests/contract.test.ts` importing the real DSH types.** It is the guard
  that makes `pnpm run typecheck` fail when an API the adapter reads disappears.
  Never replace a real type import there with a local structural stand-in — that
  is precisely how upstream shipped code that compiled but could not run.
- **`pnpm test` needs the real packages installed.** Run `pnpm install` first;
  `tests/contract.test.ts` cannot typecheck without `@deepseek-ai/dsh-*`.
- **No telemetry, no analytics, no network requests at runtime.** Settings live in
  `localStorage` only. No third-party services.
- **Minimal dependencies.** TypeScript + tsdown + vitest only. Avoid UI frameworks
  unless necessary (React ^18.2.0 matches the host if used).
- **Do not download assets from the internet.** Use the procedural whale renderer;
  sprite assets go in `assets/whale/` with an `ATTRIBUTION.md` entry.
- All Harness-specific detection logic stays in `src/adapters/deepseek-harness.ts`
  with a pure `(SignalSnapshot) → PetStatus` core. Never scatter state detection
  into pet/UI code.
- Respect `prefers-reduced-motion: reduce`.

## Build & test

```sh
pnpm install        # or npm install
pnpm test           # vitest (unit: state machine, adapter, storage, singleton guard)
pnpm run typecheck  # tsc --noEmit
pnpm bundle         # tsdown → lib/client.js (+ node half if any)
```

## Dev loop (on the user's machine)

- Install into the live profile from the repo's parent directory:
  `dsh plugin --profile desktop add link:../harness-pet`
- The Desktop app owns the `desktop` profile, so the CLI manages its packages but
  the running app must be **fully restarted** after an install/remove. Code-only
  rebuilds just need a page refresh.
- The bundled `pnpm` inside the app is not on `PATH`; `dsh plugin` needs a real
  `pnpm` on `PATH` (and a git install also needs an `allowBuilds` key).
- Verify in the browser console: `window.__DSH_BOOT__.entries` contains
  `harness-pet`; `fetch('/plugins/harness-pet/client.js')` returns 200.
- Confirm the gate first — an incompatible `engines.dsh`/peer set is rejected
  before pnpm runs, with the profile restored:
  `dsh plugin --profile <name> add link:../harness-pet`

## Honesty rules

- If a pet state cannot be reliably detected, say so in the final report — do not
  fake it. `success` is derived from `running: true→false` without error; document
  it as such.
- Distinguish automated verification from items that require manual testing.
- The pet's client half runs in a real browser page with the host's guard proxy
  around `ctx`; a change that only passes unit tests is **not** verified.

## Final report format (SPEC §12)

1. Which mechanism Harness uses for agent-status detection.
2. List of new files.
3. Install/load instructions (npm, git, link).
4. Verification results (automated vs. manual).
5. States that cannot be reliably identified (explicitly, without fabrication).
6. Whether anything was committed/pushed/published.
