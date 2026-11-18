import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.mjs'

const root = mkdtempSync(join(tmpdir(), 'preset-loader-watch-'))

function writePreset(id) {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(
    join(root, id, 'preset.cordis.yml'),
    [
      `- id: preset-${id}`,
      '  name: "@deepseek-ai/dsh-agent-preset"',
      '  config:',
      `    id: ${id}`,
      `    name: ${id}`,
      '    plugins:',
      '      - id: tool-subagent',
      '        name: "@deepseek-ai/dsh-tool-subagent"',
      '        config:',
      '          provider: spawn',
      `          agentPreset: ${id}`,
      '',
    ].join('\n'),
  )
}

const registered = new Map()
const versions = new Map()
const effects = []
const warnings = []

const ctx = {
  get: (name) => (name === 'profileContext' ? { dir: '/home/yf/.dsh/profiles/web', home: '/home/yf/.dsh' } : undefined),
  logger: { info: () => {}, warn: (message) => warnings.push(message), debug: () => {} },
  effect(fn) {
    effects.push(fn())
  },
  inject(_deps, callback) {
    callback(ctx)
  },
  tools: { register: () => () => {} },
  agentPresets: {
    get defaultId() {
      return 'solo'
    },
    async register(config) {
      if (registered.has(config.id)) throw new Error(`duplicate: ${config.id}`)
      registered.set(config.id, config)
      versions.set(config.id, (versions.get(config.id) ?? 0) + 1)
      return async () => registered.delete(config.id)
    },
    async list() {
      return [...registered.values()].map((config) => ({ id: config.id }))
    },
    composedPreset: () => undefined,
  },
}

const allowlistOf = (id) => {
  const config = registered.get(id)
  if (config === undefined) return []
  const rows = []
  const walk = (plugins) => {
    for (const row of plugins) {
      if (row.name === '@deepseek-ai/dsh-tool-subagent' && row.config?.provider === 'spawn') rows.push(row.config)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(config.plugins)
  return rows[0].allowedAgentPresets ?? []
}

try {
  writePreset('solo')
  await apply(ctx, { root })
  if (!registered.has('solo')) throw new Error('solo was not registered')
  const before = versions.get('solo')
  if (allowlistOf('solo').join(',') !== 'solo') throw new Error(`unexpected allowlist: ${allowlistOf('solo')}`)

  // A new directory joins the roster, so the existing preset's allowlist grows.
  writePreset('sibling')
  await delay(1200)
  if (!registered.has('sibling')) throw new Error('sibling was not registered')
  if ([...allowlistOf('solo')].sort().join(',') !== 'sibling,solo') throw new Error(`allowlist did not follow the roster: ${allowlistOf('solo')}`)
  if (versions.get('solo') <= before) throw new Error('solo was not re-registered after the roster changed')
  console.log('new preset -> re-register with the new allowlist OK')

  // A changed local plugin re-registers the same preset.
  const beforePlugin = versions.get('solo')
  writeFileSync(join(root, 'solo', 'extra-guard.mjs'), 'export const name = "extra-guard"\nexport function apply() {}\n')
  await delay(1200)
  if (versions.get('solo') <= beforePlugin) throw new Error('solo was not re-registered after adding a plugin')
  console.log('add plugin -> re-register OK')

  // Removing a directory withdraws it and shrinks the remaining allowlists.
  rmSync(join(root, 'sibling'), { recursive: true, force: true })
  await delay(1200)
  if (registered.has('sibling')) throw new Error('removed preset was not withdrawn')
  if (allowlistOf('solo').join(',') !== 'solo') throw new Error(`allowlist kept a withdrawn preset: ${allowlistOf('solo')}`)
  console.log('remove preset -> withdraw OK')

  for (const dispose of effects.splice(0)) await Promise.resolve(dispose()).catch(() => {})
  if (registered.size !== 0) throw new Error('dispose did not withdraw every registration')
  console.log('dispose -> clean OK')
  console.log('WATCH TEST PASSED')
} finally {
  for (const dispose of effects.splice(0)) await Promise.resolve(dispose()).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
