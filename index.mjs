/**
 * @y916/dsh-agent-preset-loader
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
 * Install it as a bundle (its own cordis.patch.yml mounts the loader):
 *
 *   dsh plugin --profile <profile> add github:y916/dsh-agent-preset-loader
 *
 * — or mount it once in the profile composition:
 *
 *   - insert:
 *       - id: local-agent-preset-loader
 *         name: file:///home/yf/.dsh/agent-preset-loader/index.mjs
 *         config:
 *           root: /home/yf/.dsh/.agent-presets
 *
 * ## Delegation preset selection
 *
 * Inside every `@deepseek-ai/dsh-tool-subagent` row of a preset, this loader
 * resolves two model-facing keys the core tool does not understand by itself:
 *
 *   allowedAgentPresets: [simplified, standard]   # whitelist
 *   notAllowedAgentPresets: [translation-agent]   # blacklist
 *   (neither key)                                 # every registered preset
 *
 * Both lists are resolved against the live roster (the presets other layers
 * already registered plus the directories this loader owns), then written back
 * as the concrete `allowedAgentPresets` whitelist the core tool accepts. The
 * resolution is redone whenever a directory changes and once more after boot,
 * when the Host tree has settled, so a preset registered by another bundle is
 * selectable without editing every preset.
 *
 * A preset that declares the sibling `list-tool` row also gets the read-only
 * `list_agent_presets` tool, mounted in that preset's own scope:
 *
 *   - id: list-agent-presets
 *     name: "@y916/dsh-agent-preset-loader/list-tool"
 *
 * The loader stamps the preset's selectable delegation ids into that row, so the
 * tool advertises exactly what `subagent` accepts. Presets that do not declare
 * the row never see the tool.
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
const SUBAGENT_TOOL = '@deepseek-ai/dsh-tool-subagent'
const ALLOWED_PRESETS = 'allowedAgentPresets'
const DENIED_PRESETS = 'notAllowedAgentPresets'
const SKILL_PROVIDER = '@deepseek-ai/dsh-skill-filesystem'
const SKILL_TOOL = '@deepseek-ai/dsh-tool-skill'
const DEBOUNCE_MS = 300
const ROSTER_REFRESH_MS = [0, 4000]
const LIST_TOOL_MODULES = [
  '@y916/dsh-agent-preset-loader/list-tool',
  '/dsh-agent-preset-loader/list-tool.mjs',
]

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

/** Non-empty string members of a YAML list, or undefined when it is not a list. */
function stringList(value) {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry) => typeof entry === 'string' && entry !== '')
}

/** Visit every plugin row, including rows nested inside `cordis:group`. */
function eachRow(plugins, visit) {
  if (!Array.isArray(plugins)) return
  for (const row of plugins) {
    if (row === null || typeof row !== 'object') continue
    visit(row)
    if (Array.isArray(row.config)) eachRow(row.config, visit)
  }
}

/** Visit every `@deepseek-ai/dsh-tool-subagent` row, including rows inside `cordis:group`. */
function eachSubagentRow(plugins, visit) {
  eachRow(plugins, (row) => {
    if (row.name === SUBAGENT_TOOL) visit(row)
  })
}

/** Whether a row mounts the sibling `list-tool` entry of this package. */
function isListToolRow(row) {
  if (typeof row.name !== 'string') return false
  return LIST_TOOL_MODULES.some((suffix) => row.name === suffix || row.name.endsWith(suffix))
}

/**
 * Resolve the declarative preset-selection keys of one preset into the concrete
 * whitelist `@deepseek-ai/dsh-tool-subagent` validates model input against.
 *
 * `allowedAgentPresets` is a whitelist, `notAllowedAgentPresets` a blacklist
 * applied after it, and neither key means every preset currently on the roster.
 * Both keys are removed from the row: the core tool rejects unknown keys.
 *
 * @param config - preset config being registered; its spawn rows are rewritten in place.
 * @param roster - preset ids that currently exist and load, in roster order.
 * @param presetId - owning preset id, for diagnostics.
 * @param logger - loader logger.
 * @returns ids every rewritten spawn row accepts, or undefined when the preset
 *   declares no preset selection at all.
 */
function resolvePresetSelection(config, roster, presetId, logger) {
  const choices = []
  eachSubagentRow(config.plugins, (row) => {
    const toolConfig = row.config
    if (toolConfig === null || typeof toolConfig !== 'object' || Array.isArray(toolConfig)) return
    // A provider that inherits the conversation (fork) cannot take an
    // independent preset; leave it untouched or it refuses to mount.
    if (toolConfig.provider === 'fork') return
    const hasWhitelist = Array.isArray(toolConfig[ALLOWED_PRESETS])
    const hasBlacklist = Array.isArray(toolConfig[DENIED_PRESETS])
    const hasDefault = typeof toolConfig.agentPreset === 'string'
    // Only rows that spawn independently get model-facing preset selection.
    if (toolConfig.provider !== 'spawn' && !hasWhitelist && !hasBlacklist && !hasDefault) return

    const whitelist = hasWhitelist ? stringList(toolConfig[ALLOWED_PRESETS]) ?? [] : undefined
    const blacklist = hasBlacklist ? stringList(toolConfig[DENIED_PRESETS]) ?? [] : []
    delete toolConfig[ALLOWED_PRESETS]
    delete toolConfig[DENIED_PRESETS]

    const allowed = (whitelist ?? roster).filter((id) => !blacklist.includes(id))
    if (allowed.length === 0) {
      logger?.warn(`agent-preset-loader: ${presetId}: preset selection resolves to no preset; leaving agent_preset unconstrained`)
      return
    }
    toolConfig[ALLOWED_PRESETS] = allowed
    if (hasDefault && !allowed.includes(toolConfig.agentPreset)) {
      logger?.warn(`agent-preset-loader: ${presetId}: default agentPreset "${toolConfig.agentPreset}" is not selectable; children inherit the parent preset instead`)
      delete toolConfig.agentPreset
    }
    choices.push(allowed)
  })
  if (choices.length === 0) return undefined
  // When one preset mounts several spawn rows, only ids every row accepts are
  // worth advertising.
  return choices.reduce((left, right) => left.filter((id) => right.includes(id)))
}

/**
 * Write the caller's selectable delegation ids into every `list-tool` row the
 * preset declares, so the tool advertises exactly what `subagent` accepts.
 *
 * A declared row in a preset with no resolved delegation keeps no stamp and
 * falls back to the whole roster; that combination is almost always a mistake,
 * so it is warned about rather than hidden.
 *
 * @param config - preset config being registered; its `list-tool` rows are stamped in place.
 * @param presetId - owning preset id, for diagnostics.
 * @param choices - ids every spawn row of this preset accepts, or undefined.
 * @param logger - loader logger.
 */
function stampListTool(config, presetId, choices, logger) {
  eachRow(config.plugins, (row) => {
    if (!isListToolRow(row)) return
    const current = row.config
    const next = current !== null && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {}
    if (choices === undefined) {
      delete next.presetIds
      logger?.warn(
        `agent-preset-loader: ${presetId}: declares list_agent_presets but selects no delegation presets; it will list the whole roster`,
      )
    } else {
      next.presetIds = [...choices]
    }
    row.config = next
  })
}

/**
 * Preset ids a delegated child may be placed on: the healthy registry roster
 * plus the directories this loader is about to register.
 *
 * @param ctx - loader context.
 * @param own - preset ids read from the loader root this round.
 * @param withRegistry - read `agentPresets.list()`; false during activation,
 *   where awaiting the Host loader can deadlock.
 * @param logger - loader logger.
 * @returns unique preset ids in roster order.
 */
async function knownPresetIds(ctx, own, withRegistry, logger) {
  const ordered = []
  const seen = new Set()
  const push = (id) => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return
    seen.add(id)
    ordered.push(id)
  }
  if (withRegistry && typeof ctx.agentPresets?.list === 'function') {
    try {
      for (const preset of await ctx.agentPresets.list()) {
        if (preset?.broken !== undefined) continue
        push(preset.id)
      }
    } catch (error) {
      logger?.warn(`agent-preset-loader: cannot read the preset roster: ${error.message}`)
    }
  }
  for (const id of own) push(id)
  return ordered
}

/** Reconcile the registry against the directory: register changed presets, withdraw removed ones. */
async function reconcile(ctx, root, yamlApi, state, withRegistry) {
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

  // Parse everything first: this round's delegation allowlists have to name the
  // presets this round registers, not only the ones already in the registry.
  const parsed = new Map()
  const unreadable = new Set()
  for (const id of dirs) {
    try {
      const preset = await readPreset(ctx, join(root, id), id, yamlApi)
      if (preset !== undefined) parsed.set(id, preset)
    } catch (error) {
      ctx.logger.warn(`agent-preset-loader: skipping ${id}: ${error.message}`)
      unreadable.add(id)
    }
  }

  // A registration this loader is about to withdraw must not stay advertised in
  // the remaining presets' allowlists while the same pass re-registers them.
  const own = new Set(parsed.keys())
  const stale = new Set([...state.keys()].filter((id) => !own.has(id) && !unreadable.has(id)))
  const roster = (await knownPresetIds(ctx, [...own], withRegistry, ctx.logger)).filter((id) => !stale.has(id))
  const seen = new Set(unreadable)
  for (const [id, { config }] of parsed) {
    const choices = resolvePresetSelection(config, roster, id, ctx.logger)
    stampListTool(config, id, choices, ctx.logger)
    const key = JSON.stringify({ config, choices })
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
      const dispose = await ctx.agentPresets.register(config)
      state.set(id, { key, config, choices, dispose })
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
  let timer
  let queue = Promise.resolve()

  ctx.effect(() => async () => {
    clearTimeout(timer)
    for (const closer of closers.splice(0)) closer()
    for (const previous of state.values()) await previous.dispose().catch(() => {})
    state.clear()
  })

  const reload = (withRegistry) => {
    queue = queue
      .then(() => reconcile(ctx, root, yamlApi, state, withRegistry))
      .catch((error) => ctx.logger.warn(`agent-preset-loader: reload failed: ${error.message}`))
    return queue
  }

  // Never await the Host loader from inside this row's activation: the roster
  // read below happens on a timer, after the tree has settled.
  await reload(false)

  // The Host may still be registering its own presets when this row activates;
  // re-read the roster after the tree settled so the allowlists cover it.
  for (const delay of ROSTER_REFRESH_MS) {
    const refresh = setTimeout(() => {
      void reload(true)
    }, delay)
    refresh.unref?.()
    closers.push(() => clearTimeout(refresh))
  }

  if (config.watch === false) return

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      void reload(true)
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
