# Changelog

All notable changes to Harness Pet are documented here.

## [0.2.1-rc.3] - 2026-10-26

Fork of [`cakeni/harness-pet`](https://github.com/cakeni/harness-pet), ported from
DeepSeek Harness `0.1.0-rc.6` to `0.2.1-rc.3`.

### Fixed — the upstream release could not load at all

- **Removed the dead `@deepseek-ai/dsh-client-runtime` dependency.** That package no longer exists in the 0.2.1 line, so its peer range blocked installation through DSH's compatibility gate.
- **Replaced `ctx.connection.hostDescription` with `ctx.connection.state`.** The old member was deleted; reading it threw during activation and aborted the whole client lifecycle.
- **Replaced `sessions.list.current` with the main-view retention rule** (`byId[id].retainedBy.mainView > 0`). The `current` field was removed from `SessionListState`, so the pet previously never bound to any session.
- **Rebuilt conversation reading on the session event window.** `SessionFace` is now `ISession & ObservableSnapshot<SessionSnapshot>`; `partial`, `nodes`, `runningCalls`, and `queue` moved off the snapshot. The adapter now reduces `binding.eventSource` (`user/message`, `assistant/message`, transient `assistant/live-chunk`, `tool/call`, `tool/result`, `turn/end`).
- **Rebuilt `waiting` detection on `uiSession.sessionStatus`**, the 0.2.1 feed that reports a pending approval or question. It is read through `ctx.get('uiSession')` and is not a hard `inject` dependency.
- **Redefined `thinking` for 0.2.1.** Upstream keyed it off a `partial` snapshot field that no longer exists, so it could never fire. A running turn with no open tool call is now `thinking`; a running turn with an open call shows `working` or the specialized tool state.
- **Guarded the client context correctly.** The runner hands `apply` a guard proxy: reading an undeclared service throws, and spreading it yields no keys. The entry now reads `sessions`/`connection` explicitly.

### Added

- **`engines.dsh: "0.2.1-rc.3"`**, which the compatibility gate evaluates on its own, so installation needs no `allow-version` exemption.
- **`tests/contract.test.ts`** — imports the real published DSH types and fails `pnpm run typecheck` when a member the adapter reads disappears. Upstream declared its own structural types, which is why it compiled while broken.
- Adapter test coverage for every 0.2.1 signal path (native `running`, `promptError`, failed `turn/end`, pending interaction, event-window tool names, streaming text, and malformed windows degrading to idle).

### Changed

- `dsh.client.inject` now lists packages that exist at `0.2.1-rc.3`.
- Install documentation targets the `desktop` profile, since the Desktop app owns that profile.
- Version aligned to the targeted Harness release.

### Verified

- `pnpm run typecheck`, `pnpm test` (73 tests), and `pnpm bundle` pass.
- `dsh plugin --profile <p> add link:…` installs **without** an `allow-version` exemption, and `--dump-config` shows the `harness-pet` row in the composed tree.
- The bundle keeps the `window.__ModuleLoader__.load` contract and still contains no `fetch`, XHR, WebSocket, `eval`, `new Function`, or `innerHTML`.

## [0.1.0] - 2026-08-14

- Added a close control for the conversation card, a **Show Dialog** recovery action in settings, and per-session dismissal behavior.
- Made the settings panel independently draggable by its title bar, with viewport clamping and small-window scrolling.
- Added a persisted interface language selector with English as the default plus Simplified Chinese, Japanese, and Korean translations.
- Prevented the settings panel from jumping while the pet-size slider changes, and clarified the independent floating-pet action for minimized Harness windows.
- Made long streamed replies follow their latest output in the dialog, and added the official `chat.legacy` signal mirror as a compatibility fallback.
- Renamed the user-facing brand to Harness Pet and replaced the old 4×4 artwork with a transparent 6×9 atlas containing six dedicated frames for each of the nine states.
- Rebuilt the animation with the open-source `hatch-pet` fixed-cell pipeline: 8×9 atlas, deterministic frame extraction, left/right drag rows, motion previews, and zero-error transparency/geometry validation.
- Enriched semantic state motion with a connected water-spout success loop, a flipper-held magnifier search loop, and a red-hot fault/error loop while retaining fixed-cell QA guarantees.
- Added the native DSH client bundle and profile patch, structured nine-state detection, local-only settings, reduced-motion support, and complete lifecycle cleanup.
- Added unit tests, GitHub Actions CI, bilingual documentation, privacy and compatibility notes, and an optional Chromium Document Picture-in-Picture pet window.
