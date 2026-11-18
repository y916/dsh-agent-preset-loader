import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.mjs'

const STAGING = '/home/yf/work/wsl/.preset-staging/.agent-presets'
const registered = new Map()
const effects = []
const logs = []
const ctx = {
  get(name) {
    if (name === 'profileContext') return { dir: '/home/yf/.dsh/profiles/web', home: '/home/yf/.dsh' }
    return undefined
  },
  logger: {
    info: (msg) => logs.push(['info', msg]),
    warn: (msg) => logs.push(['warn', msg]),
    debug: () => {},
  },
  effect(fn) { effects.push(fn()) },
  agentPresets: {
    async register(config) {
      if (registered.has(config.id)) throw new Error(`Duplicate agent preset: ${config.id}`)
      registered.set(config.id, config)
      return async () => { registered.delete(config.id) }
    },
  },
}

const root = mkdtempSync(join(tmpdir(), 'preset-loader-'))
cpSync(STAGING, root, { recursive: true })
// one per-preset skill for the skill discovery row
mkdirSync(join(root, 'simplified', 'demo-skill'), { recursive: true })
writeFileSync(join(root, 'simplified', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\n\n# demo\n')

await apply(ctx, { root, watch: false })

const ids = [...registered.keys()].sort()
console.log('registered:', ids)
if (ids.join(',') !== 'director,simplified,translation-agent') throw new Error('unexpected preset ids')

const simplified = registered.get('simplified')
const director = registered.get('director')
const translation = registered.get('translation-agent')

const names = (config) => {
  const out = []
  const walk = (rows) => {
    for (const row of rows) {
      if (typeof row.name === 'string') out.push(row.name)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(config.plugins)
  return out
}

const sNames = names(simplified)
console.log('simplified rows:', sNames.length)
if (!sNames.includes('@deepseek-ai/dsh-tool-skill')) throw new Error('simplified lost tool-skill')
if (!sNames.includes('@deepseek-ai/dsh-skill-filesystem')) throw new Error('simplified missing scoped skill provider')
const provider = simplified.plugins.find((row) => row.name === '@deepseek-ai/dsh-skill-filesystem' && row.config?.providerName)
if (!provider || provider.config.customSkillDirs[0] !== join(root, 'simplified')) throw new Error('skill provider misconfigured')
if (!provider.config.providerName.startsWith('agent-preset-simplified')) throw new Error('skill provider name')

const dNames = names(director)
if (!dNames.includes(`file://${join(root, 'director', 'tool-deny.mjs')}`)) throw new Error('director tool-deny not auto-mounted')
if (!dNames.includes('@deepseek-ai/dsh-tool-skill')) throw new Error('director lost tool-skill')
const jsExpr = JSON.stringify(director.plugins).includes('__jsExpr')
if (!jsExpr) throw new Error('!!js expressions were not preserved')

const tNames = names(translation)
if (!tNames.includes(`file://${join(root, 'translation-agent', 'tool-restriction.mjs')}`)) throw new Error('translation tool-restriction not auto-mounted')
if (tNames.includes('@deepseek-ai/dsh-tool-skill')) throw new Error('tool-free preset gained tool-skill')

for (const [id, config] of registered) {
  const allIds = []
  const walkIds = (rows) => {
    for (const row of rows) {
      if (row.id !== undefined) allIds.push(row.id)
      if (Array.isArray(row.config)) walkIds(row.config)
    }
  }
  walkIds(config.plugins)
  const dupes = allIds.filter((rowId, index) => allIds.indexOf(rowId) !== index)
  if (dupes.length) throw new Error(`duplicate row ids in ${id}: ${dupes.join(',')}`)
}

console.log('logs:', logs.length ? logs.slice(0, 3) : 'none')
console.log('SMOKE TEST PASSED')
rmSync(root, { recursive: true, force: true })
