/**
 * @yf/dsh-agent-preset-loader
 *
 * One directory is one agent preset:
 *
 *   $DSH_HOME/.agent-presets/<id>/
 *     preset.cordis.yml     # entry list holding one @deepseek-ai/dsh-agent-preset row,
 *                           #   or the bare preset config mapping
 *     *.mjs                 # local plugin modules, mounted automatically (skip `_*.mjs`)
 *     <skill-name>/SKILL.md # per-preset skills, discovered through a scoped
 *                           #   dsh-skill-filesystem provider
 *
 * The plugin registers every directory as an ordinary registry declaration,
 * so no preset rows need to live in cordis.patch.yml. It watches the root and
 * re-registers a preset when its files change (a full dsh restart picks up
 * everything too).
 *
 * Mount it once in the profile composition:
 *
 *   - insert:
 *       - id: local-agent-preset-loader
 *         name: file:///home/yf/.dsh/agent-preset-loader/index.mjs
 *         config:
 *           root: /home/yf/.dsh/.agent-presets
 */
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, watch as fsWatch } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

export const name = 'agent-preset-loader'
export const inject = ['agentPresets']

const PRESET_FILES = ['preset.cordis.yml', 'agent.cordis.yml']
const PRESET_ROW = '@deepseek-ai/dsh-agent-preset'
const SKILL_PROVIDER = '@deepseek-ai/dsh-skill-filesystem'
const SKILL_TOOL = '@deepseek-ai/dsh-tool-skill'
const DEBOUNCE_MS = 300

const yamlCache = new Map()

function profileDirOf(ctx) {
  return ctx.get('profileContext')?.dir
}

function dshHomeOf(ctx) {
  return ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Resolve the profile's own js-yaml (already installed) and build the dsh YAML dialect. */
async function yamlFor(ctx) {
  const profileDir = profileDirOf(ctx)
  const key = profileDir ?? '<fallback>'
  const cached = yamlCache.get(key)
  if (cached) return cached
  const candidates = [profileDir, join(dshHomeOf(ctx), 'profiles', 'web'), process.cwd()].filter(Boolean)
  let yaml
  const errors = []
  for (const dir of candidates) {
    try {
      yaml = createRequire(join(dir, 'package.json'))('js-yaml')
      break
    } catch (error) {
      errors.push(`${dir}: ${error.message}`)
    }
  }
  if (yaml === undefined) throw new Error(`cannot resolve js-yaml from the profile (${errors.join('; ')})`)
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: (data) => data instanceof Object && '__jsExpr' in data,
    represent: (data) => data['__jsExpr'],
  })
  const api = { yaml, schema: yaml.JSON_SCHEMA.extend(JsExpr) }
  yamlCache.set(key, api)
  return api
}

function resolveRoot(ctx, configured) {
  if (typeof configured === 'string' && configured !== '') return resolve(configured)
  return join(dshHomeOf(ctx), '.agent-presets')
}

function sanitizeId(text) {
  return text.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'preset'
}

/** Rewrite relative or absolute filesystem entry names against the preset directory. */
function absolutizeRows(rows, dir) {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.name === 'string' && (row.name.startsWith('./') || row.name.startsWith('../') || row.name.startsWith('/'))) {
      row.name = pathToFileURL(resolve(dir, row.name)).href
    }
    if (Array.isArray(row.config)) absolutizeRows(row.config, dir)
  }
  return rows
}

function collectSets(rows, names, ids) {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.name === 'string') names.add(row.name)
    if (typeof row.id === 'string') ids.add(row.id)
    if (Array.isArray(row.config)) collectSets(row.config, names, ids)
  }
  return { names, ids }
}

function cleanId(candidate, used) {
  let id = candidate
  let n = 2
  while (used.has(id)) id = `${candidate}-${n++}`
  used.add(id)
  return id
}

/** Build the preset config from one file's parsed YAML. */
function extractConfig(data, id, file, logger) {
  let config
  if (Array.isArray(data)) {
    const row = data.find((entry) => entry !== null && typeof entry === 'object' && entry.config && (entry.name === undefined || entry.name === PRESET_ROW))
    if (row === undefined) throw new Error(`${file}: no ${PRESET_ROW} row with a config`)
    config = structuredClone(row.config)
  } else if (data !== null && typeof data === 'object') {
    config = structuredClone(data)
  } else {
    throw new Error(`${file}: expected an entry list or a preset config mapping`)
  }
  if (typeof config.id === 'string' && config.id !== id) {
    logger?.warn(`agent-preset-loader: ${file} declares id "${config.id}" but its directory is "${id}"; using "${id}"`)
  }
  config.id = id
  if (!Array.isArray(config.plugins)) config.plugins = []
  return config
}

async function localPluginRows(dir, config, usedIds, names) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const rows = []
  for (const file of files) {
    const url = pathToFileURL(join(dir, file)).href
    if (names.has(url)) continue
    rows.push({ id: cleanId(`local-${sanitizeId(basename(file, '.mjs'))}`, usedIds), name: url })
  }
  return rows
}

async function skillRows(dir, config, usedIds, names) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const hasSkill = entries.some((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
  if (!hasSkill) return []
  const rows = [
    {
      id: cleanId('preset-skills', usedIds),
      name: SKILL_PROVIDER,
      config: {
        providerName: `agent-preset-${sanitizeId(basename(dir))}`,
        includeDefaultRoots: false,
        customSkillDirs: [dir],
        watch: true,
      },
    },
  ]
  if (!names.has(SKILL_TOOL)) rows.push({ id: cleanId('tool-skill', usedIds), name: SKILL_TOOL })
  return rows
}

/** Read one preset directory into a complete preset config, or undefined when it declares none. */
async function readPreset(ctx, dir, id, yamlApi) {
  let file
  for (const candidate of PRESET_FILES) {
    const path = join(dir, candidate)
    if (existsSync(path)) {
      file = path
      break
    }
  }
  if (file === undefined) return undefined
  const text = await readFile(file, 'utf8')
  const data = yamlApi.yaml.load(text, { schema: yamlApi.schema })
  const config = extractConfig(data, id, file, ctx.logger)
  absolutizeRows(config.plugins, dir)
  const { names, ids } = collectSets(config.plugins, new Set(), new Set())
  config.plugins.push(...(await localPluginRows(dir, config, ids, names)))
  config.plugins.push(...(await skillRows(dir, config, ids, names)))
  return { file, config }
}

/** Reconcile the registry against the directory: register changed presets, withdraw removed ones. */
async function reconcile(ctx, root, yamlApi, state) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    ctx.logger.warn(`agent-preset-loader: cannot read ${root}: ${error.message}`)
    return
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const seen = new Set()
  for (const id of dirs) {
    let parsed
    try {
      parsed = await readPreset(ctx, join(root, id), id, yamlApi)
    } catch (error) {
      ctx.logger.warn(`agent-preset-loader: skipping ${id}: ${error.message}`)
      if (state.has(id)) seen.add(id)
      continue
    }
    if (parsed === undefined) continue
    const key = JSON.stringify(parsed.config)
    const previous = state.get(id)
    if (previous !== undefined && previous.key === key) {
      seen.add(id)
      continue
    }
    if (previous !== undefined) {
      await previous.dispose()
      state.delete(id)
    }
    try {
      const dispose = await ctx.agentPresets.register(parsed.config)
      state.set(id, { key, config: parsed.config, dispose })
      ctx.logger.info(`agent-preset-loader: registered preset ${id}`)
    } catch (error) {
      ctx.logger.warn(`agent-preset-loader: failed to register ${id}: ${error.message}`)
      if (previous !== undefined) {
        try {
          const dispose = await ctx.agentPresets.register(previous.config)
          state.set(id, { ...previous, dispose })
        } catch (restoreError) {
          ctx.logger.warn(`agent-preset-loader: could not restore previous ${id}: ${restoreError.message}`)
        }
      }
    }
    seen.add(id)
  }
  for (const [id, previous] of [...state]) {
    if (seen.has(id)) continue
    await previous.dispose()
    state.delete(id)
    ctx.logger.info(`agent-preset-loader: withdrew preset ${id}`)
  }
}

export async function apply(ctx, config = {}) {
  const yamlApi = await yamlFor(ctx)
  const root = resolveRoot(ctx, config.root)
  const state = new Map()
  const closers = []

  ctx.effect(() => async () => {
    for (const closer of closers.splice(0)) closer()
    for (const previous of state.values()) await previous.dispose().catch(() => {})
    state.clear()
  })

  await reconcile(ctx, root, yamlApi, state)

  if (config.watch === false) return
  let queue = Promise.resolve()
  let timer
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      queue = queue
        .then(() => reconcile(ctx, root, yamlApi, state))
        .catch((error) => ctx.logger.warn(`agent-preset-loader: reload failed: ${error.message}`))
    }, DEBOUNCE_MS)
    timer.unref?.()
  }
  try {
    const watcher = fsWatch(root, { recursive: true, persistent: false }, schedule)
    watcher.on('error', (error) => ctx.logger.warn(`agent-preset-loader: watcher error: ${error.message}`))
    closers.push(() => {
      clearTimeout(timer)
      watcher.close()
    })
  } catch (error) {
    ctx.logger.warn(`agent-preset-loader: filesystem watch disabled for ${root}: ${error.message}`)
  }
}
