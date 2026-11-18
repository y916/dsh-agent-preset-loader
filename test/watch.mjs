import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.mjs'

const STAGING = '/home/yf/work/wsl/.preset-staging/.agent-presets'
const root = mkdtempSync(join(tmpdir(), 'preset-loader-watch-'))
cpSync(STAGING, root, { recursive: true })

const versions = new Map()
const active = new Set()
const ctx = {
  get: (name) => (name === 'profileContext' ? { dir: '/home/yf/.dsh/profiles/web', home: '/home/yf/.dsh' } : undefined),
  logger: { info: () => {}, warn: (msg) => console.log('WARN', msg), debug: () => {} },
  effect(fn) { this._dispose = fn() },
  agentPresets: {
    async register(config) {
      if (active.has(config.id)) throw new Error('duplicate')
      active.add(config.id)
      versions.set(config.id, (versions.get(config.id) ?? 0) + 1)
      return async () => { active.delete(config.id) }
    },
  },
}

await apply(ctx, { root, watch: true })
const before = versions.get('director')
if (!active.has('director')) throw new Error('director not registered')

writeFileSync(join(root, 'director', 'extra-guard.mjs'), 'export const name = "extra-guard"\nexport function apply() {}\n')
await delay(1200)
if (versions.get('director') !== before + 1) throw new Error('director was not re-registered after adding a plugin')
console.log('add plugin -> re-register OK')

rmSync(join(root, 'translation-agent'), { recursive: true, force: true })
await delay(1200)
if (active.has('translation-agent')) throw new Error('removed preset was not withdrawn')
console.log('remove preset -> withdraw OK')

await ctx._dispose()
if (active.size !== 0) throw new Error('dispose did not withdraw every registration')
console.log('dispose -> clean OK')
console.log('WATCH TEST PASSED')
rmSync(root, { recursive: true, force: true })
