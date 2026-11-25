import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildPlugin } from "../scripts/build-plugin.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

test("buildPlugin creates a self-contained multi-host bundle that runs CLI, hooks, and MCP without node_modules", { timeout: 20000 }, async (t) => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memdex-plugin-build-")));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const outDir = path.join(tempRoot, "memdex");
  await buildPlugin(outDir, { marketplace: "qwang07" });

  for (const manifest of [
    "package.json",
    "plugin.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    const parsed = JSON.parse(fs.readFileSync(path.join(outDir, manifest), "utf8"));
    assert.equal(parsed.version, PKG_VERSION, `${manifest} version mismatch`);
  }
  assert.ok(fs.existsSync(path.join(outDir, "skills", "memdex", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(outDir, "skills", "memdex-dream", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(outDir, "node_modules")));

  const cliPath = path.join(outDir, "bin", "memdex.mjs");
  const ver = spawnSync(process.execPath, [cliPath, "--version"], { encoding: "utf8", cwd: tempRoot });
  assert.equal(ver.status, 0, ver.stderr);
  assert.equal(ver.stdout.trim(), PKG_VERSION);

  const isolatedHome = path.join(tempRoot, "memdex-home");
  const env = {
    ...process.env,
    HOME: path.join(tempRoot, "home"),
    MEMDEX_HOME: isolatedHome,
    MEMDEX_DB: path.join(isolatedHome, "memory.db"),
    MEMDEX_NOTES_DIR: path.join(isolatedHome, "notes"),
    PLUGIN_ROOT: outDir,
  };
  fs.mkdirSync(env.HOME, { recursive: true });

  for (const host of ["claude", "codex", "antigravity"]) {
    const hook = spawnSync(process.execPath, [cliPath, "hook", "session-start", "--host", host], {
      encoding: "utf8",
      cwd: tempRoot,
      env,
      input: "{}",
    });
    assert.equal(hook.status, 0, `${host} hook failed: ${hook.stderr}`);
    assert.deepEqual(JSON.parse(hook.stdout), {});
  }

  // Verify the exact Antigravity mcp_config.json import(bin/memdex.mjs).then(m => m.runCli(['mcp'])) launcher.
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(outDir, "mcp_config.json"), "utf8"));
  const { command, args } = mcpConfig.mcpServers.memdex;
  const transport = new StdioClientTransport({ command, args, env, cwd: tempRoot, stderr: "pipe" });
  const client = new Client({ name: "bundle-smoke", version: PKG_VERSION });
  try {
    await client.connect(transport, { timeout: 5000 });
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "list_memory_notes"));
    assert.ok(tools.some((tool) => tool.name === "search_past_memory"));
  } finally {
    await client.close();
  }
});
