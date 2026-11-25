# Memdex plugin

Generated package of [Memdex](https://github.com/qwang07/memdex) for Claude Code, Codex, and Antigravity. Do not edit this directory by hand. It is rebuilt from the source repository by `node scripts/build-plugin.mjs` and published to the `plugin` branch when a `v*` tag is pushed.

Requires **Node.js 22.5 or newer** on `PATH` (Memdex uses the built-in `node:sqlite`). The CLI, MCP server, and hooks are bundled into `dist/memdex.mjs`, so no `npm install` is needed.

| Host | Manifest | What it wires |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` | `memdex` MCP server, `SessionStart` memory index and `Stop` import of the finished session (`--host claude`), Skills |
| Codex | `.codex-plugin/plugin.json` | `memdex` MCP server, `SessionStart` and `Stop` hooks (`--host codex`), Skills |
| Antigravity | `plugin.json`, `mcp_config.json`, `hooks.json` | `memdex` MCP server, `SessionStart` and `Stop` hooks (`--host antigravity`), Skills |

All hosts share one store under `~/.memdex` (override with `MEMDEX_HOME`). Run `node dist/memdex.mjs sync` once to backfill earlier conversations from every supported host.

## Install

From the [qwang07 marketplace](https://github.com/qwang07/plugins):

```sh
# Claude Code
/plugin marketplace add qwang07/plugins
/plugin install memdex@qwang07

# Codex
codex plugin marketplace add qwang07/plugins
codex plugin add memdex@qwang07
```

Codex asks you to trust a plugin's hooks before they run. Approve the Memdex hooks to get the startup index and automatic session import.

For Antigravity, clone the `plugin` branch and copy or link the package into the plugins folder:

```sh
git clone --branch plugin --single-branch https://github.com/qwang07/memdex.git memdex-release
ln -s "$(pwd)/memdex-release/plugins/memdex" ~/.gemini/config/plugins/memdex
```

Run `git -C memdex-release pull --ff-only` to update.
