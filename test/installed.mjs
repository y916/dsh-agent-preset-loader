import { apply } from '../index.mjs'
const registered = new Map()
const ctx = {
  get: (name) => (name === 'profileContext' ? { dir: '/home/yf/.dsh/profiles/web', home: '/home/yf/.dsh' } : undefined),
  logger: { info: (m) => console.log('INFO', m), warn: (m) => console.log('WARN', m), debug: () => {} },
  effect(fn) { this._dispose = fn() },
  agentPresets: { async register(config) { if (registered.has(config.id)) throw new Error('dup ' + config.id); registered.set(config.id, config); return async () => registered.delete(config.id) } },
}
await apply(ctx, { root: '/home/yf/.dsh/.agent-presets', watch: false })
console.log('registered:', [...registered.keys()].sort().join(', '))
const LIST_TOOL = '@y916/dsh-agent-preset-loader/list-tool'
for (const [id, config] of registered) {
  const names = []
  let listRow
  const walk = (rows) => { for (const row of rows) { if (typeof row.name === 'string') names.push(row.name); if (row.name === LIST_TOOL) listRow = row; if (Array.isArray(row.config)) walk(row.config) } }
  walk(config.plugins)
  const local = names.filter((n) => n.startsWith('file:///home/yf/.dsh/.agent-presets/'))
  const skills = names.includes('@deepseek-ai/dsh-skill-filesystem')
  const roster = listRow === undefined ? 'absent' : `declared:${(listRow.config?.presetIds ?? []).length}`
  console.log(`- ${id}: rows=${names.length} local=${local.length} skillProvider=${skills} toolSkill=${names.includes('@deepseek-ai/dsh-tool-skill')} listTool=${roster}`)
}
await ctx._dispose()
console.log('OK')
