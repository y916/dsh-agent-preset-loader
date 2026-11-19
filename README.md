# @y916/dsh-agent-preset-loader

Directory-backed agent presets for DeepSeek Harness. One directory is one preset:

```
$DSH_HOME/.agent-presets/<id>/
  preset.cordis.yml      # one @deepseek-ai/dsh-agent-preset row (or the bare config mapping)
  *.mjs                  # local plugin modules, mounted automatically; `_*.mjs` is ignored
  <skill-name>/SKILL.md  # per-preset skills (direct children of <id>)
```

The loader scans the root, registers every directory through
`ctx.agentPresets.register(...)`, watches for changes, and withdraws presets whose
directory disappears. Nothing needs to be declared per preset in
`cordis.patch.yml`.

## What it composes

For each `<id>`:

1. `preset.cordis.yml` supplies the preset config. The directory name is the
   preset id (`config.id` is forced to it). Entry names starting with `./`,
   `../` or `/` are rewritten to absolute `file://` URLs against `<id>/`.
2. Every top-level `*.mjs` (except `_*.mjs` and dotfiles) is appended as a
   plugin row unless `preset.cordis.yml` already references the same file.
3. If `<id>` contains `<skill-name>/SKILL.md`, a scoped
   `@deepseek-ai/dsh-skill-filesystem` provider is appended with
   `includeDefaultRoots: false` and `customSkillDirs: [<id>]`; a
   `@deepseek-ai/dsh-tool-skill` row is appended too when the preset does not
   already mount one. A preset without skill directories is left untouched
   (so tool-free presets stay tool-free).

## Delegation preset selection

The core `@deepseek-ai/dsh-tool-subagent` only understands a concrete
`allowedAgentPresets` whitelist. This loader adds the two declarative keys
below on any `spawn` row and resolves them against the live preset roster:

```yaml
- id: tool-subagent
  name: "@deepseek-ai/dsh-tool-subagent"
  config:
    provider: spawn
    agentPreset: simplified          # default child preset; optional
    # allowedAgentPresets: [simplified, standard]   # whitelist
    # notAllowedAgentPresets: [translation-agent]   # blacklist, applied after the whitelist
```

- `allowedAgentPresets` — only these ids are selectable.
- `notAllowedAgentPresets` — every preset except these is selectable.
- neither key — every preset on the roster is selectable (the default).

Both keys are removed from the row before registration (the core tool rejects
unknown keys), and the resolved whitelist is written back as
`allowedAgentPresets`. A default `agentPreset` that the resolved list does not
contain is dropped with a warning, so children fall back to inheriting the
parent preset instead of failing to mount. Rows whose provider inherits the
conversation (`provider: fork`) are never touched.

The roster is the union of every preset the registry reports as usable and the
directories this loader owns. It is re-read on every directory change, and once
more shortly after boot, when the Host tree has settled — so a preset declared
by another bundle becomes selectable without editing each preset. A withdrawn
directory leaves the remaining allowlists on the same pass.

## `list_agent_presets` (opt-in per preset)

Nothing registers this read-only tool automatically: the loader is mounted in the
profile scope, so a tool registered there would be visible to every agent in the
profile. A preset opts in by declaring the sibling entry as one of its own rows:

```yaml
- id: list-agent-presets
  name: "@y916/dsh-agent-preset-loader/list-tool"
```

The row carries no configuration. When the loader registers the preset it stamps
that preset's resolved delegation ids into `config.presetIds`, so the tool
advertises exactly the ids `subagent` accepts. Declare the row in presets that
can delegate (`subagent`, `subagent_fork`, `workflow`, `spawn_teammate`); presets
without it never carry the extra schema.

```
list_agent_presets → [{ id, name, description, isDefault }, ...]
```

It answers `ctx.agentPresets.list()`, drops unusable (broken) presets, and keeps
only the stamped ids. A row that was not stamped (mounted by hand, or a preset
whose delegation resolved to nothing — the loader warns about that case) reports
the whole healthy roster instead. The model-facing text is one line per preset:
`id (name) [default] — description`.

Breaking change in 0.3: earlier versions registered this tool globally.

## Install

```bash
dsh plugin --profile <profile> add github:y916/dsh-agent-preset-loader
```

or install it as a bundle from the Plugins page. This package is a bundle: its
`cordis.patch.yml` auto-mounts the loader, so the profile's own patch layer
needs no row. `root` defaults to `$DSH_HOME/.agent-presets`; set
`config.root` to override it and `config.watch: false` to disable the
filesystem watcher. Changes to `preset.cordis.yml` or the folder set take
effect immediately; edits inside a `SKILL.md` body are picked up by the skill
provider itself.

## Tests

```bash
node test/smoke.mjs      # registration, preset selection, roster-tool stamping + schema
node test/watch.mjs      # hot reload, withdrawal, dispose
node test/installed.mjs  # read the real $DSH_HOME/.agent-presets tree
```

`smoke.mjs` validates the rewritten rows and the tool schema against the
installed `@deepseek-ai/dsh-tool-subagent` / `@deepseek-ai/dsh-tools` packages
resolved from the `web` profile.

## Notes

- YAML is parsed with the profile's own `js-yaml` plus a `!!js` tag, so loader
  expressions in preset rows survive registration.
- `register()` resolves once the definition is recorded; an activation failure
  is reported by the registry roster (not thrown here). The loader never calls
  `resolve()`/`list()` inside `apply()` (that can deadlock on the Host loader);
  the roster refresh runs on a timer after activation.
- A parse error keeps the previous registration for that id and logs a warning.
- `config.watch: false` only disables the filesystem watcher: the post-boot
  roster refresh still runs, so presets declared by other layers are selectable
  without restarting. Only later directory edits then need a restart.
