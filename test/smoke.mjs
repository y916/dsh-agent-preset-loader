import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.mjs'
import { apply as applyListTool } from '../list-tool.mjs'

const PROFILE = '/home/yf/.dsh/profiles/web'
const require = createRequire(join(PROFILE, 'package.json'))
const LIST_TOOL_MODULE = '@y916/dsh-agent-preset-loader/list-tool'

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

const LIST_ROW = ['- id: list-agent-presets', `  name: "${LIST_TOOL_MODULE}"`]

const root = mkdtempSync(join(tmpdir(), 'preset-loader-smoke-'))
function writePreset(id, rows) {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'preset.cordis.yml'), presetYaml(id, rows))
}

// alpha: no preset keys at all -> every preset is selectable; declares the roster tool.
writePreset('alpha', [...SPAWN(['agentPreset: alpha']), ...LIST_ROW])
// beta: explicit whitelist, declares the roster tool.
writePreset('beta', [...SPAWN(['agentPreset: beta', 'allowedAgentPresets:', '  - alpha']), ...LIST_ROW])
// gamma: blacklist plus a default that the blacklist removes; declares nothing.
writePreset('gamma', SPAWN(['agentPreset: alpha', 'notAllowedAgentPresets:', '  - alpha']))
// delta: no delegation rows at all, but declares the roster tool (a mistake we warn about).
writePreset('delta', ['- id: persona', '  name: "@deepseek-ai/dsh-persona"', ...LIST_ROW])

const registered = new Map()
const versions = new Map()
const warnings = []
const effects = []

const hostRows = [
  { id: 'standard', name: '标准', description: 'host preset' },
  { id: 'broken-one', broken: 'row never started' },
]

// The loader itself needs no tool service any more: the roster tool lives in the
// preset scope of the presets that declare it.
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

const rowsNamed = (config, name) => {
  const rows = []
  const walk = (plugins) => {
    for (const row of plugins) {
      if (row.name === name) rows.push(row)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(config.plugins)
  return rows
}

const spawnRow = (config) => rowsNamed(config, '@deepseek-ai/dsh-tool-subagent').find((row) => row.config?.provider === 'spawn')
const forkRow = (config) => rowsNamed(config, '@deepseek-ai/dsh-tool-subagent').find((row) => row.config?.provider === 'fork')
const listRow = (config) => rowsNamed(config, LIST_TOOL_MODULE)[0]

try {
  await apply(ctx, { root })

  // The first pass cannot read the Host roster from inside activation, so the
  // allowlist starts with this loader's own directories only.
  const initial = spawnRow(registered.get('alpha')).config.allowedAgentPresets
  if (initial.join(',') !== 'alpha,beta,delta,gamma') throw new Error(`unexpected first-pass allowlist: ${initial}`)
  const initialStamp = listRow(registered.get('alpha')).config.presetIds
  if (initialStamp.join(',') !== 'alpha,beta,delta,gamma') throw new Error(`unexpected first-pass stamp: ${initialStamp}`)

  // The deferred roster refresh picks up presets registered by other layers
  // and re-registers the presets whose allowlist changed.
  await delay(150)
  const alpha = spawnRow(registered.get('alpha')).config
  const roster = alpha.allowedAgentPresets
  if (!roster.includes('standard')) throw new Error(`host preset missing from allowlist: ${roster}`)
  if (roster.includes('broken-one')) throw new Error('broken preset leaked into the allowlist')
  if (alpha.agentPreset !== 'alpha') throw new Error('default agentPreset was lost')
  if (forkRow(registered.get('alpha')).config.allowedAgentPresets !== undefined) throw new Error('fork row must stay untouched')

  // The roster tool row is stamped with exactly the ids the spawn row accepts.
  const alphaStamp = listRow(registered.get('alpha')).config.presetIds
  if (alphaStamp.join(',') !== roster.join(',')) throw new Error(`stamp ${alphaStamp} != allowlist ${roster}`)

  // Whitelist and blacklist both resolve against the roster.
  const beta = spawnRow(registered.get('beta')).config
  if (beta.allowedAgentPresets.join(',') !== 'alpha') throw new Error(`whitelist not honored: ${beta.allowedAgentPresets}`)
  if (listRow(registered.get('beta')).config.presetIds.join(',') !== 'alpha') throw new Error('whitelist stamp not honored')
  const gamma = spawnRow(registered.get('gamma')).config
  if (gamma.allowedAgentPresets.includes('alpha')) throw new Error('blacklist not applied')
  if (gamma.agentPreset !== undefined) throw new Error('a blacklisted default must be dropped')
  if (!warnings.some((line) => line.includes('is not selectable'))) throw new Error('missing warning for the dropped default')

  // A preset without the row is not given one, and a declared row without
  // delegation is warned about instead of silently listing everything.
  if (listRow(registered.get('gamma')) !== undefined) throw new Error('the loader must not inject the roster tool row')
  const deltaRow = listRow(registered.get('delta'))
  if (deltaRow === undefined) throw new Error('the declared roster tool row disappeared')
  if (deltaRow.config.presetIds !== undefined) throw new Error('a delegation-free preset must not be stamped')
  if (!warnings.some((line) => line.includes('selects no delegation presets'))) {
    throw new Error('missing warning for a roster tool without delegation')
  }

  // Every rewritten row must satisfy the core tool's own config contract.
  const subagentModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent')).href)
  for (const [id, config] of registered) {
    for (const row of rowsNamed(config, '@deepseek-ai/dsh-tool-subagent')) {
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

  // The roster tool module itself: schema validity, stamped filtering, fallback.
  const toolsModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
  const mounted = []
  const scopeCtx = {
    effect(fn) {
      mounted.push(fn())
    },
    tools: {
      register(tool) {
        mounted.push(tool)
        return () => {}
      },
    },
    agentPresets: ctx.agentPresets,
  }

  applyListTool(scopeCtx, { presetIds: alphaStamp })
  const stamped = mounted.find((entry) => entry?.name === 'list_agent_presets')
  if (stamped === undefined) throw new Error('the roster tool did not register')
  toolsModule.assertSupportedJsonSchema(stamped.parameters)
  toolsModule.assertObjectJsonSchema(stamped.parameters)
  toolsModule.assertSupportedJsonSchema(stamped.output.schema)

  const filtered = await stamped.execute({}, {})
  const ids = (rows) => rows.map((row) => row.id).sort().join(',')
  if (ids(filtered) !== [...alphaStamp].sort().join(',')) {
    throw new Error(`stamped roster rows wrong: ${filtered.map((row) => row.id)}`)
  }
  if (!filtered.find((row) => row.id === 'alpha')?.isDefault) throw new Error('default flag missing')
  if (filtered.some((row) => row.id === 'broken-one')) throw new Error('broken preset leaked into the roster tool')
  if (!stamped.output.render({}, filtered)[0]?.text?.includes('标准')) throw new Error('render lost the roster')

  applyListTool(scopeCtx, {})
  const unstamped = mounted.filter((entry) => entry?.name === 'list_agent_presets')[1]
  const whole = await unstamped.execute({}, {})
  if (!whole.some((row) => row.id === 'beta')) throw new Error('an unstamped row must fall back to the whole roster')

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
