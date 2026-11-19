/**
 * @y916/dsh-agent-preset-loader/list-tool
 *
 * The read-only `list_agent_presets` tool. Nothing registers it automatically:
 * a preset opts in by declaring this module as one of its own plugin rows, so
 * only presets that can actually delegate carry the extra tool schema.
 *
 *   - id: list-agent-presets
 *     name: "@y916/dsh-agent-preset-loader/list-tool"
 *
 * The row needs no configuration of its own. When the loader registers a preset
 * it writes that preset's selectable delegation ids into `config.presetIds`, so
 * the tool advertises exactly the ids `subagent` accepts. A row the loader did
 * not stamp (mounted by hand, or a preset whose delegation it could not resolve)
 * reports the whole healthy roster instead.
 */
export const name = 'agent-preset-list-tool'
export const inject = ['tools', 'agentPresets']

export const TOOL_NAME = 'list_agent_presets'

/** Declared ids, or undefined when the loader stamped none. */
function stampedPresetIds(config) {
  if (!Array.isArray(config?.presetIds)) return undefined
  return config.presetIds.filter((id) => typeof id === 'string' && id !== '')
}

function definition(ctx, presetIds) {
  const allowed = presetIds === undefined ? undefined : new Set(presetIds)
  return {
    name: TOOL_NAME,
    description:
      'List the agent presets this agent may pass as `agent_preset` when delegating, with each preset id, display name, description, and whether it is the deployment default. Read-only and takes no arguments; call it before choosing a preset for `subagent` or `spawn_teammate`.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'isDefault'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            isDefault: { type: 'boolean' },
          },
        },
      },
      render: (_args, presets) => [
        {
          type: 'text',
          text:
            presets.length === 0
              ? '(no agent preset is available to this agent)'
              : presets
                  .map((preset) => {
                    const label = preset.name === undefined ? preset.id : `${preset.id} (${preset.name})`
                    const flag = preset.isDefault ? ' [default]' : ''
                    const detail = preset.description === undefined ? '' : ` — ${preset.description}`
                    return `- ${label}${flag}${detail}`
                  })
                  .join('\n'),
        },
      ],
    },
    async execute() {
      const defaultId = ctx.agentPresets.defaultId
      const rows = []
      for (const preset of await ctx.agentPresets.list()) {
        if (preset.broken !== undefined) continue
        if (allowed !== undefined && !allowed.has(preset.id)) continue
        rows.push({
          id: preset.id,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
          isDefault: preset.id === defaultId,
        })
      }
      return rows
    },
  }
}

/**
 * Register the roster tool in this preset's scope.
 * @param ctx - preset-scope context carrying `tools` and `agentPresets`.
 * @param config - row config; `presetIds` is stamped by the loader.
 */
export function apply(ctx, config = {}) {
  const tool = definition(ctx, stampedPresetIds(config))
  const register = () => ctx.tools.register(tool)
  if (typeof ctx.effect === 'function') ctx.effect(register)
  else register()
}

export default { name, inject, apply }
