/**
 * Built-artifact contract and safety checks.
 *
 * Unit tests exercise the TypeScript source; this suite inspects the actual
 * `lib/client.js` the host will serve at `/plugins/harness-pet/client.js`. It
 * pins the module-loader envelope the runtime requires and the privacy claims
 * the README makes, so a dependency or build change cannot quietly introduce a
 * network call or break the registration format.
 *
 * Run `pnpm bundle` first (CI does); the suite skips when the artifact is absent.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
if (!existsSync(bundlePath)) {
  throw new Error('lib/client.js is missing — run `pnpm bundle` before `pnpm test`')
}
const source = readFileSync(bundlePath, 'utf8')

describe('built client bundle', () => {
  it('registers under the module-loader envelope the host expects', () => {
    expect(source.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(source).toContain('id: "harness-pet"')
    expect(source).toContain('factory: (require) => {')
    // The factory closes before the trailing sourcemap comment.
    expect(source).toMatch(/\}\}\);\s*(\/\/# sourceMappingURL=.*)?$/)
  })

  it('exports the plugin half as { apply, inject }', () => {
    expect(source).toMatch(/exports\.apply\s*=/)
    expect(source).toMatch(/exports\.inject\s*=/)
  })

  it('carries no runtime network or dynamic-code primitives', () => {
    // These are the primitives that would contradict the privacy section.
    for (const forbidden of [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'sendBeacon',
      'eval(',
      'new Function',
      'document.write',
      'innerHTML',
      'outerHTML',
      'importScripts',
      'child_process',
      'process.env',
    ]) {
      expect(source, `bundle must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('persists only settings in localStorage', () => {
    const hits = source.match(/localStorage/g) ?? []
    // The storage module references it once as the default backing store.
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.length).toBeLessThanOrEqual(3)
    // No other browser storage is used.
    for (const forbidden of ['sessionStorage', 'indexedDB', 'document.cookie']) {
      expect(source, `bundle must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('inlines the sprite instead of requesting it at runtime', () => {
    expect(source).toContain('data:image/webp;base64,')
  })

  it('declares no removed 0.1.0 runtime package', () => {
    expect(source).not.toContain('dsh-client-runtime')
    expect(source).not.toContain('hostDescription')
  })
})
