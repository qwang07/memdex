#!/usr/bin/env node
/**
 * Build the installable Memdex plugin package for Claude Code, Codex, and Antigravity.
 *
 * The package is one self-contained directory: the CLI (MCP server + hooks) is bundled with
 * esbuild into `bin/memdex.mjs`, so hosts that install from git never need `npm install`.
 *
 *   node scripts/build-plugin.mjs --out <dir> [--marketplace qwang07]
 *
 * Layout of <dir>:
 *   bin/memdex.mjs              bundled CLI (node >= 22.5, uses built-in node:sqlite)
 *   package.json                name/version only (read by `memdex --version`)
 *   skills/, docs/              shared Skills and the docs they link to
 *   .claude-plugin/plugin.json  Claude Code: MCP + SessionStart/Stop hooks (--host claude)
 *   .codex-plugin/plugin.json   Codex: MCP + SessionStart/Stop hooks (--host codex)
 *   plugin.json, mcp_config.json, hooks.json   Antigravity (same files as the repository root)
 */

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const DESCRIPTION =
  "Local-first cross-project conversation memory: SessionStart memory index, incremental Stop-hook syncing, and Chinese/English MCP recall over SQLite FTS5.";
const KEYWORDS = ["memory", "recall", "mcp", "sqlite", "fts5", "conversations"];
const AUTHOR = { name: "qwang07", url: "https://github.com/qwang07" };
const HOMEPAGE = "https://github.com/qwang07/memdex#readme";
const REPOSITORY = "https://github.com/qwang07/memdex";
const PROMPTS = [
  "Search Memdex for what we decided about this project earlier",
  "List my recent conversations across projects",
  "Run a Memdex Dream review for this project",
];

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

function hookGroups(command) {
  return {
    SessionStart: [{ hooks: [{ type: "command", command: `${command} hook session-start --host HOST`, timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "command", command: `${command} hook stop --host HOST`, timeout: 15 }] }],
  };
}

function withHost(groups, host) {
  return JSON.parse(JSON.stringify(groups).replaceAll("--host HOST", `--host ${host}`));
}

/**
 * Codex does not interpolate the plugin root inside stdio MCP arguments, so the server is
 * launched from the versioned plugin cache (same approach as the Milestone Codex package).
 */
function codexLauncher(marketplace, name, version) {
  const script = [
    "import { homedir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const [marketplace, plugin, version, ...args] = process.argv.slice(1);",
    "const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');",
    "const cli = join(codexHome, 'plugins', 'cache', marketplace, plugin, version, 'bin', 'memdex.mjs');",
    "const { runCli } = await import(pathToFileURL(cli).href);",
    "await runCli(args);",
  ].join("\n");
  return ["--input-type=module", "--eval", script, "--", marketplace, name, version, "mcp"];
}

export async function buildPlugin(destination, { marketplace = "qwang07" } = {}) {
  const out = path.resolve(destination);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "bin"), { recursive: true });

  await build({
    entryPoints: [path.join(ROOT, "bin", "memdex.mjs")],
    outfile: path.join(out, "bin", "memdex.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    banner: { js: "import { createRequire as __memdexCreateRequire } from 'node:module'; const require = __memdexCreateRequire(import.meta.url);" },
    logLevel: "warning",
  });
  fs.chmodSync(path.join(out, "bin", "memdex.mjs"), 0o755);

  const { name, version } = pkg;
  writeJson(path.join(out, "package.json"), { name, version, private: true, type: "module", license: pkg.license });

  for (const dir of ["skills", "docs"]) {
    fs.cpSync(path.join(ROOT, dir), path.join(out, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(out, "LICENSE"));
  fs.copyFileSync(path.join(ROOT, "plugin", "README.md"), path.join(out, "README.md"));

  // Antigravity reads the root manifest, MCP config, and hook group (relative to the plugin root).
  const antigravity = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
  writeJson(path.join(out, "plugin.json"), { ...antigravity, version });
  fs.copyFileSync(path.join(ROOT, "mcp_config.json"), path.join(out, "mcp_config.json"));
  fs.copyFileSync(path.join(ROOT, "hooks.json"), path.join(out, "hooks.json"));

  const shared = {
    name,
    version,
    description: DESCRIPTION,
    author: AUTHOR,
    homepage: HOMEPAGE,
    repository: REPOSITORY,
    license: pkg.license,
    keywords: KEYWORDS,
  };

  writeJson(path.join(out, ".claude-plugin", "plugin.json"), {
    ...shared,
    mcpServers: {
      memdex: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bin/memdex.mjs", "mcp"] },
    },
    hooks: { hooks: withHost(hookGroups('node "${CLAUDE_PLUGIN_ROOT}/bin/memdex.mjs"'), "claude") },
  });

  writeJson(path.join(out, ".codex-plugin", "plugin.json"), {
    ...shared,
    skills: "./skills/",
    // Inline (not a root .mcp.json) so Claude Code never picks up the Codex launcher.
    mcpServers: {
      memdex: {
        type: "stdio",
        command: "node",
        args: codexLauncher(marketplace, name, version),
        // Codex starts MCP servers with a minimal environment; forward the two homes Memdex reads.
        env_vars: ["CODEX_HOME", "MEMDEX_HOME"],
      },
    },
    hooks: { hooks: withHost(hookGroups('node "${PLUGIN_ROOT}/bin/memdex.mjs"'), "codex") },
    interface: {
      displayName: "Memdex",
      shortDescription: "Cross-project conversation memory and recall",
      longDescription:
        "Indexes local Codex, Claude Code, Antigravity, and Gemini CLI transcripts into a local SQLite FTS5 store, loads the scoped memory index at session start, imports each finished session on Stop, and exposes recall, note saving, and manual Dream review over MCP. Requires Node.js 22.5+.",
      developerName: "qwang07",
      category: "Productivity",
      capabilities: ["Read", "Write"],
      websiteURL: HOMEPAGE,
      defaultPrompt: PROMPTS,
    },
  });
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: "string" }, marketplace: { type: "string" } } });
  if (!values.out) {
    process.stderr.write("Usage: node scripts/build-plugin.mjs --out <dir> [--marketplace qwang07]\n");
    process.exit(1);
  }
  process.stdout.write(`${await buildPlugin(values.out, { marketplace: values.marketplace })}\n`);
}
