import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.mjs'

const PROFILE = '/home/yf/.dsh/profiles/web'
const require = createRequire(join(PROFILE, 'package.json'))

function presetYaml(id, rows) {
  return [
    '- id: preset-' + id,
    '  name: "@deepseek-ai/dsh-agent-preset"',
    '  config:',
    '    id: ' + id,
    '    name: ' + id,
    '    description: preset ' + id,
    '    plugins:',
    ...rows.map((line) => '      ' + line),
    '',
  ].join('\n')
}

const SPAWN = (extra) => [
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent',
  '      name: "@deepseek-ai/dsh-tool-subagent"',
  '      config:',
  '        provider: spawn',
  ...extra.map((line) => '        ' + line),
  '    - id: tool-subagent-fork',
  '      name: "@deepseek-ai/dsh-tool-subagent"',
  '      config:',
  '        provider: fork',
  '        toolName: subagent_fork',
]

const root = mkdtempSync(join(tmpdir(), 'preset-loader-smoke-'))
function writePreset(id, rows) {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'preset.cordis.yml'), presetYaml(id, rows))
}

// alpha: no preset keys at all -> every preset is selectable
writePreset('alpha', SPAWN(['agentPreset: alpha']))
// beta: explicit whitelist
writePreset('beta', SPAWN(['agentPreset: beta', 'allowedAgentPresets:', '  - alpha']))
// gamma: blacklist plus a default that the blacklist removes
writePreset('gamma', SPAWN(['agentPreset: alpha', 'notAllowedAgentPresets:', '  - alpha']))
// delta: no delegation rows at all
writePreset('delta', ['- id: persona', '  name: "@deepseek-ai/dsh-persona"'])

const registered = new Map()
const versions = new Map()
const tools = []
const warnings = []
const effects = []

const hostRows = [
  { id: 'standard', name: '标准', description: 'host preset' },
  { id: 'broken-one', broken: 'row never started' },
]

const ctx = {
  get: (name) => (name === 'profileContext' ? { dir: PROFILE, home: '/home/yf/.dsh' } : undefined),
  logger: {
    info: () => {},
    warn: (message) => warnings.push(message),
    debug: () => {},
  },
  effect(fn) {
    effects.push(fn())
  },
  inject(_deps, callback) {
    callback(ctx)
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  agentPresets: {
    get defaultId() {
      return 'alpha'
    },
    async register(config) {
      if (registered.has(config.id)) throw new Error(`duplicate: ${config.id}`)
      registered.set(config.id, config)
      versions.set(config.id, (versions.get(config.id) ?? 0) + 1)
      return async () => registered.delete(config.id)
    },
    async list() {
      return [
        ...hostRows,
        ...[...registered.values()].map((config) => ({
          id: config.id,
          name: config.name,
          description: config.description,
        })),
      ]
    },
    composedPreset(agentCtx) {
      return agentCtx?.preset
    },
  },
}

const toolRows = (config) => {
  const rows = []
  const walk = (plugins) => {
    for (const row of plugins) {
      if (row.name === '@deepseek-ai/dsh-tool-subagent') rows.push(row)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(config.plugins)
  return rows
}

const spawnRow = (config) => toolRows(config).find((row) => row.config?.provider === 'spawn')
const forkRow = (config) => toolRows(config).find((row) => row.config?.provider === 'fork')

try {
  await apply(ctx, { root })

  // The first pass cannot read the Host roster from inside activation, so the
  // allowlist starts with this loader's own directories only.
  const initial = spawnRow(registered.get('alpha')).config.allowedAgentPresets
  if (initial.join(',') !== 'alpha,beta,delta,gamma') throw new Error(`unexpected first-pass allowlist: ${initial}`)

  // The deferred roster refresh picks up presets registered by other layers
  // and re-registers the presets whose allowlist changed.
  await delay(150)
  const alpha = spawnRow(registered.get('alpha')).config
  const roster = alpha.allowedAgentPresets
  if (!roster.includes('standard')) throw new Error(`host preset missing from allowlist: ${roster}`)
  if (roster.includes('broken-one')) throw new Error('broken preset leaked into the allowlist')
  if (alpha.agentPreset !== 'alpha') throw new Error('default agentPreset was lost')
  if (forkRow(registered.get('alpha')).config.allowedAgentPresets !== undefined) throw new Error('fork row must stay untouched')

  // Whitelist and blacklist both resolve against the roster.
  const beta = spawnRow(registered.get('beta')).config
  if (beta.allowedAgentPresets.join(',') !== 'alpha') throw new Error(`whitelist not honored: ${beta.allowedAgentPresets}`)
  const gamma = spawnRow(registered.get('gamma')).config
  if (gamma.allowedAgentPresets.includes('alpha')) throw new Error('blacklist not applied')
  if (gamma.agentPreset !== undefined) throw new Error('a blacklisted default must be dropped')
  if (!warnings.some((line) => line.includes('is not selectable'))) throw new Error('missing warning for the dropped default')

  // Every rewritten row must satisfy the core tool's own config contract.
  const subagentModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent')).href)
  for (const [id, config] of registered) {
    for (const row of toolRows(config)) {
      const resolved = subagentModule.Config(row.config)
      const allowed = resolved.allowedAgentPresets
      if (allowed === undefined) continue
      if (new Set(allowed).size !== allowed.length) throw new Error(`${id}: duplicate ids in allowedAgentPresets`)
      if (resolved.agentPreset !== undefined && !allowed.includes(resolved.agentPreset)) {
        throw new Error(`${id}: agentPreset is not part of allowedAgentPresets`)
      }
      if (row.config.notAllowedAgentPresets !== undefined) throw new Error(`${id}: notAllowedAgentPresets reached the core tool`)
    }
  }

  // The roster tool: definition shape, then per-caller filtering.
  if (tools.length !== 1 || tools[0].name !== 'list_agent_presets') throw new Error(`unexpected tools: ${tools.map((tool) => tool.name)}`)
  const definition = tools[0]
  const toolsModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
  toolsModule.assertSupportedJsonSchema(definition.parameters)
  toolsModule.assertObjectJsonSchema(definition.parameters)
  toolsModule.assertSupportedJsonSchema(definition.output.schema)

  const asAlpha = await definition.execute({}, { agent: { ctx: { preset: 'alpha' } } })
  const alphaIds = asAlpha.map((row) => row.id)
  if (!alphaIds.includes('standard') || alphaIds.includes('broken-one')) throw new Error(`roster rows wrong: ${alphaIds}`)
  if (!asAlpha.find((row) => row.id === 'alpha')?.isDefault) throw new Error('default flag missing')

  const asBeta = await definition.execute({}, { agent: { ctx: { preset: 'beta' } } })
  if (asBeta.map((row) => row.id).join(',') !== 'alpha') throw new Error(`whitelisted caller sees ${asBeta.map((row) => row.id)}`)

  const asGamma = await definition.execute({}, { agent: { ctx: { preset: 'gamma' } } })
  if (asGamma.some((row) => row.id === 'alpha')) throw new Error('blacklisted preset shown to the caller')

  const rendered = definition.output.render({}, asAlpha)
  if (!rendered[0]?.text?.includes('standard')) throw new Error('render lost the roster')

  // Removing a directory withdraws the registration on the next pass.
  rmSync(join(root, 'delta'), { recursive: true, force: true })
  await delay(1200)
  if (registered.has('delta')) throw new Error('removed preset was not withdrawn')

  console.log('registered:', [...registered.keys()].sort().join(','))
  console.log('allowlist:', roster.join(','))
  console.log('warnings:', warnings.length)
  console.log('SMOKE TEST PASSED')
} finally {
  for (const dispose of effects.splice(0)) await Promise.resolve(dispose()).catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
