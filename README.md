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

## Notes

- YAML is parsed with the profile's own `js-yaml` plus a `!!js` tag, so loader
  expressions in preset rows survive registration.
- `register()` resolves once the definition is recorded; an activation failure
  is reported by the registry roster (not thrown here). The loader never calls
  `resolve()` inside `apply()` (that can deadlock on the Host loader).
- A parse error keeps the previous registration for that id and logs a warning.
