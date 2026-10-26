/**
 * Manifest contract for the host compatibility gate.
 *
 * `dsh plugin add` runs `evaluatePluginCompatibility` before pnpm: an exact-range
 * `engines.dsh` that does not cover the installed runtime rejects the whole
 * install (and rolls the profile back). These assertions pin the fields the gate
 * reads, and the range semantics chosen for them.
 *
 * The semantics were verified against DSH's own `semver.satisfies(..., {
 * includePrerelease: true })`:
 *
 *   range              | 0.2.1-rc.3 | 0.2.1-rc.4 | 0.2.2 | 0.3.0 | 0.1.0-rc.6
 *   -------------------|------------|------------|-------|-------|-----------
 *   "0.2.1-rc.3"       |    yes     |     no     |  no   |  no   |    no
 *   "^0.2.1-rc.3"      |    yes     |    yes     |  yes  |  no   |    no
 *   ">=0.1.0"          |    yes     |    yes     |  yes  |  yes  |    no
 *
 * An exact pin would break on the next Harness patch, and `>=0.1.0` would
 * re-admit the 0.3 line where the contracts this fork reads may change again.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as {
  name: string
  version: string
  license: string
  engines?: { dsh?: string }
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
  peerDependencies?: Record<string, string>
  files?: string[]
  exports?: Record<string, unknown>
}

describe('host compatibility gate manifest', () => {
  it('pins the runtime range the gate evaluates', () => {
    expect(manifest.engines?.dsh).toBe('^0.2.1-rc.3')
  })

  it('never names the removed 0.1.0 runtime package', () => {
    for (const field of [manifest.peerDependencies, (manifest as { devDependencies?: Record<string, string> }).devDependencies]) {
      expect(Object.keys(field ?? {})).not.toContain('@deepseek-ai/dsh-client-runtime')
    }
  })

  it('keeps every harness peer on the advertised runtime line', () => {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      // A peer pinned below the target line would contradict engines.dsh.
      expect(range, `${name} peer range`).toMatch(/\^?0\.2\.1-rc\.3|~4\.0\.5/)
    }
  })

  it('declares the bundle patch and the browser half', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    // Module-graph activation ids; must resolve inside the install tree.
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-api-session-controller')
    expect(manifest.dsh?.client?.inject).not.toContain('@deepseek-ai/dsh-client-runtime')
  })

  it('ships the built artifact and the license it claims', () => {
    expect(manifest.license).toBe('MIT')
    expect(manifest.files).toContain('lib')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.exports?.['./client']).toBeDefined()
  })

  it('keeps the fork attribution in the description', () => {
    expect(manifest.name).toBe('harness-pet')
    expect((manifest as { description?: string }).description).toMatch(/unofficial community project/i)
  })
})
