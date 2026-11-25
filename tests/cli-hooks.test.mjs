import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  initDb,
  searchMessages,
  upsertConversationRecord,
  upsertMemory,
  workspaceToSlug,
} from "../scripts/harness.mjs";
import {
  buildSessionStartContext,
  DREAM_MIN_INTERVAL_HOURS,
  DREAM_MIN_UNSYNTHESIZED_SESSIONS,
  evaluateDreamReminder,
  supportsSqliteReadOnly,
} from "../src/hooks.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(PLUGIN_ROOT, "bin", "memdex.mjs");
const HARNESS_PATH = path.join(PLUGIN_ROOT, "scripts", "harness.mjs");
const MCP_SERVER_PATH = path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs");

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function buildIsolatedEnv(memdexHome, extra = {}) {
  const env = { ...process.env };
  delete env.MEMDEX_DB;
  delete env.MEMDEX_NOTES_DIR;
  delete env.MEMDEX_BRAIN_DIRS;
  env.MEMDEX_HOME = memdexHome;
  return { ...env, ...extra };
}

function runCliSync(args, { memdexHome, input = "", env = {}, cwd = PLUGIN_ROOT } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: buildIsolatedEnv(memdexHome, env),
  });
}

function seedConversation(db, id, { workspace = "/Users/dev/projects/proj-a", messageCount = 2, dreamedAt = "", dreamedMsgCount = 0 } = {}) {
  const messages = [];
  for (let i = 0; i < messageCount; i += 1) {
    messages.push({
      stepIndex: i,
      role: i % 2 === 0 ? "USER" : "AI",
      content: `Synthetic message ${i} for ${id}`,
      timestamp: "2026-11-20T10:00:00Z",
    });
  }
  upsertConversationRecord(db, {
    id,
    source: "antigravity",
    workspace,
    lastUpdated: "2026-11-20T10:00:00Z",
    messages,
  });
  if (dreamedAt || dreamedMsgCount > 0) {
    db.prepare("UPDATE conversations SET dreamed_at = ?, dreamed_msg_count = ? WHERE id = ?").run(
      dreamedAt,
      dreamedMsgCount,
      id
    );
  }
}

async function verifyMcpEntrypoint(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: PLUGIN_ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const pending = [];
  let buffer = "";
  const rawLines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      rawLines.push(line);
      const msg = JSON.parse(line);
      const resolver = pending.shift();
      if (resolver) resolver(msg);
    }
  });

  const nextMessage = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout. stderr=${stderr}`)), 5000);
      pending.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "cli-test-client", version: "0.2.0" },
        },
      }) + "\n"
    );
    const initResp = await nextMessage();
    assert.equal(initResp.id, 1);
    assert.ok(initResp.result);

    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    const listResp = await nextMessage();
    const names = new Set(listResp.result.tools.map((t) => t.name));

    assert.deepEqual(
      names,
      new Set([
        "get_memory_index",
        "read_memory",
        "upsert_memory",
        "delete_memory",
        "search_past_memory",
        "get_conversation_detail",
        "list_recent_conversations",
        "sync_memory_now",
        "get_dream_candidates",
        "mark_dreamed",
      ])
    );

    // Ensure every stdout line emitted was valid JSON-RPC protocol.
    for (const line of rawLines) {
      const parsed = JSON.parse(line);
      assert.equal(parsed.jsonrpc, "2.0");
    }
  } finally {
    child.kill();
  }
}

describe("memdex unified CLI & thin Hook adapter layer", () => {
  let tmpDir;
  let memdexHome;
  let dbPath;
  let notesDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memdex-cli-hooks-"));
    memdexHome = path.join(tmpDir, "memdex-home");
    dbPath = path.join(memdexHome, "memory.db");
    notesDir = path.join(memdexHome, "notes");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wires package.json bin, package-lock.json root bin, hooks.json SessionStart+Stop, and mcp_config.json launch metadata", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    assert.equal(pkg.bin?.memdex, "./bin/memdex.mjs");
    assert.ok(pkg.scripts.test);
    assert.ok(pkg.scripts.sync);
    assert.ok(pkg.scripts.search);
    assert.ok(pkg.scripts.list);

    const pkgLock = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package-lock.json"), "utf8"));
    const lockedPackage = pkgLock.packages[""];
    assert.equal(lockedPackage.version, pkg.version);
    assert.equal(lockedPackage.bin?.memdex, path.posix.normalize(pkg.bin.memdex));
    assert.deepEqual(lockedPackage.engines, pkg.engines);
    assert.deepEqual(lockedPackage.dependencies, pkg.dependencies);

    if (process.platform !== "win32") {
      const mode = fs.statSync(CLI_PATH).mode;
      assert.ok((mode & 0o111) !== 0, `expected executable bit on ${CLI_PATH}, got mode 0${(mode & 0o777).toString(8)}`);
    }

    const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "hooks.json"), "utf8"));
    const group = hooks.memdex;
    assert.ok(group, "hooks.json must define memdex hook group");
    assert.equal(group.SessionStart.length, 1);
    assert.equal(group.SessionStart[0].type, "command");
    assert.match(group.SessionStart[0].command, /bin\/memdex\.mjs hook session-start --host antigravity/);
    assert.equal(group.Stop.length, 1);
    assert.equal(group.Stop[0].type, "command");
    assert.match(group.Stop[0].command, /bin\/memdex\.mjs hook stop --host antigravity/);

    const mcpConfig = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "mcp_config.json"), "utf8"));
    assert.equal(mcpConfig.mcpServers.memdex.command, "node");
    assert.ok(mcpConfig.mcpServers.memdex.args.join(" ").includes("memdex.mjs"));
  });

  it("supports direct executable invocation and symlinked CLI invocation", () => {
    if (process.platform === "win32") return;

    const { version } = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
    const directVer = spawnSync(CLI_PATH, ["--version"], {
      cwd: PLUGIN_ROOT,
      encoding: "utf8",
      env: buildIsolatedEnv(memdexHome),
    });
    assert.equal(directVer.status, 0, directVer.stderr);
    assert.equal(directVer.stdout.trim(), version);

    const symlinkBin = path.join(tmpDir, "memdex");
    fs.symlinkSync(CLI_PATH, symlinkBin);

    const symlinkVer = spawnSync(symlinkBin, ["--version"], {
      cwd: tmpDir,
      encoding: "utf8",
      env: buildIsolatedEnv(memdexHome),
    });
    assert.equal(symlinkVer.status, 0, symlinkVer.stderr);
    assert.equal(symlinkVer.stdout.trim(), version);

    const symlinkHook = spawnSync(symlinkBin, ["hook", "session-start", "--host", "plain"], {
      cwd: tmpDir,
      input: "{}",
      encoding: "utf8",
      env: buildIsolatedEnv(memdexHome),
    });
    assert.equal(symlinkHook.status, 0, symlinkHook.stderr);
    assert.equal(symlinkHook.stdout.trim(), "{}");
  });

  it("stays silently {} on an empty store across all 4 hosts without creating memory.db", () => {
    const hosts = [
      { host: "antigravity", payload: { conversationId: "c-empty", workspacePaths: ["/Users/dev/projects/none"] } },
      { host: "claude", payload: { session_id: "s-empty", cwd: "/Users/dev/projects/none" } },
      { host: "gemini", payload: { session_id: "g-empty", cwd: "/Users/dev/projects/none" } },
      { host: "plain", payload: { workspace: "/Users/dev/projects/none" } },
    ];

    for (const { host, payload } of hosts) {
      const res = runCliSync(["hook", "session-start", "--host", host], {
        memdexHome,
        input: JSON.stringify(payload),
      });
      assert.equal(res.status, 0, `${host} stderr=${res.stderr}`);
      assert.equal(res.stdout.trim(), "{}", `${host} must output {} on empty store`);
      assert.equal(res.stderr, "", `${host} must stay quiet on stderr`);
    }

    assert.equal(fs.existsSync(dbPath), false, "SessionStart must not create memory.db on empty MEMDEX_HOME");

    // Also verify initialized but empty DB (0 conversations, 0 notes) stays {} (no false reminder on no history).
    const db = initDb(dbPath);
    db.close();
    for (const { host, payload } of hosts) {
      const res = runCliSync(["hook", "session-start", "--host", host], {
        memdexHome,
        input: JSON.stringify(payload),
      });
      assert.equal(res.status, 0);
      assert.deepEqual(JSON.parse(res.stdout), {});
    }
  });

  it("emits exact official SessionStart JSON for antigravity, claude, gemini, and plain with workspace isolation and no L2 body reads", () => {
    const realProjA = path.join(tmpDir, "workspaces", "proj-alpha");
    const realProjB = path.join(tmpDir, "workspaces", "proj-beta");
    const symlinkProjA = path.join(tmpDir, "links", "proj-alpha-link");
    fs.mkdirSync(realProjA, { recursive: true });
    fs.mkdirSync(realProjB, { recursive: true });
    fs.mkdirSync(path.dirname(symlinkProjA), { recursive: true });
    fs.symlinkSync(realProjA, symlinkProjA);

    const db = initDb(dbPath);
    try {
      upsertMemory(db, {
        scope: "global",
        type: "user",
        slug: "node-esm-pref",
        name: "技术栈偏好",
        description: "优先使用纯 Node.js ESM 与内置 node:sqlite",
        content: "SECRET_BODY_GLOBAL_NEVER_INJECTED_111",
        notesDir,
      });
      upsertMemory(db, {
        scope: "project",
        workspace: realProjA,
        type: "project",
        slug: "alpha-arch",
        name: "Alpha 架构约定",
        description: "Alpha 项目统一通过 bin/memdex.mjs 暴露 CLI",
        content: "SECRET_BODY_ALPHA_NEVER_INJECTED_222",
        notesDir,
      });
      upsertMemory(db, {
        scope: "project",
        workspace: realProjB,
        type: "project",
        slug: "beta-secret",
        name: "Beta 专属规则",
        description: "OTHER_PROJECT_BETA_LEAK_GUARD",
        content: "SECRET_BODY_BETA_NEVER_INJECTED_333",
        notesDir,
      });
    } finally {
      db.close();
    }

    const alphaSlug = workspaceToSlug(realProjA);

    // 1. Antigravity: uses workspacePaths[0] (including symlink normalization), nested injectSteps.systemMessage.systemMessage
    const agyRes = runCliSync(["hook", "session-start", "--host", "antigravity"], {
      memdexHome,
      input: JSON.stringify({
        conversationId: "conv-agy-1",
        workspacePaths: [`${symlinkProjA}/`, realProjB],
      }),
    });
    assert.equal(agyRes.status, 0, agyRes.stderr);
    const agyJson = JSON.parse(agyRes.stdout);
    assert.ok(Array.isArray(agyJson.injectSteps));
    assert.equal(agyJson.injectSteps.length, 1);
    const agyText = agyJson.injectSteps[0]?.systemMessage?.systemMessage;
    assert.equal(typeof agyText, "string");
    assert.ok(agyText.includes("global/node-esm-pref"));
    assert.ok(agyText.includes(`projects/${alphaSlug}/alpha-arch`));
    assert.ok(!agyText.includes("OTHER_PROJECT_BETA_LEAK_GUARD"), "must only use workspacePaths[0] and never leak projB");
    assert.ok(!agyText.includes("SECRET_BODY_GLOBAL_NEVER_INJECTED_111"), "must not read L2 global note body");
    assert.ok(!agyText.includes("SECRET_BODY_ALPHA_NEVER_INJECTED_222"), "must not read L2 project note body");

    // 1b. Antigravity with empty workspacePaths -> global-only
    const agyGlobalRes = runCliSync(["hook", "session-start", "--host", "antigravity"], {
      memdexHome,
      input: JSON.stringify({ conversationId: "conv-agy-2", workspacePaths: [] }),
    });
    assert.equal(agyGlobalRes.status, 0);
    const agyGlobalText = JSON.parse(agyGlobalRes.stdout).injectSteps[0].systemMessage.systemMessage;
    assert.ok(agyGlobalText.includes("global/node-esm-pref"));
    assert.ok(!agyGlobalText.includes("alpha-arch"), "no workspace must only load global index");
    assert.ok(!agyGlobalText.includes("OTHER_PROJECT_BETA_LEAK_GUARD"));

    // 2. Claude Code: uses cwd -> hookSpecificOutput.hookEventName="SessionStart" + additionalContext
    const claudeRes = runCliSync(["hook", "session-start", "--host", "claude"], {
      memdexHome,
      input: JSON.stringify({
        session_id: "claude-sess-1",
        cwd: realProjA,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    });
    assert.equal(claudeRes.status, 0, claudeRes.stderr);
    const claudeJson = JSON.parse(claudeRes.stdout);
    assert.equal(claudeJson.hookSpecificOutput?.hookEventName, "SessionStart");
    const claudeText = claudeJson.hookSpecificOutput?.additionalContext;
    assert.equal(typeof claudeText, "string");
    assert.ok(claudeText.includes("global/node-esm-pref"));
    assert.ok(claudeText.includes(`projects/${alphaSlug}/alpha-arch`));
    assert.ok(!claudeText.includes("OTHER_PROJECT_BETA_LEAK_GUARD"));
    assert.ok(!claudeText.includes("SECRET_BODY_ALPHA_NEVER_INJECTED_222"));

    // 2b. Claude Code without cwd -> global-only
    const claudeGlobalRes = runCliSync(["hook", "session-start", "--host", "claude"], {
      memdexHome,
      input: JSON.stringify({ session_id: "claude-sess-2" }),
    });
    assert.equal(claudeGlobalRes.status, 0);
    const claudeGlobalJson = JSON.parse(claudeGlobalRes.stdout);
    assert.equal(claudeGlobalJson.hookSpecificOutput?.hookEventName, "SessionStart");
    assert.ok(claudeGlobalJson.hookSpecificOutput.additionalContext.includes("global/node-esm-pref"));
    assert.ok(!claudeGlobalJson.hookSpecificOutput.additionalContext.includes("alpha-arch"));

    // 3. Gemini CLI: uses cwd -> hookSpecificOutput.additionalContext
    const geminiRes = runCliSync(["hook", "session-start", "--host", "gemini"], {
      memdexHome,
      input: JSON.stringify({
        session_id: "gemini-sess-1",
        cwd: realProjA,
        source: "startup",
      }),
    });
    assert.equal(geminiRes.status, 0, geminiRes.stderr);
    const geminiJson = JSON.parse(geminiRes.stdout);
    assert.deepEqual(Object.keys(geminiJson), ["hookSpecificOutput"]);
    assert.deepEqual(Object.keys(geminiJson.hookSpecificOutput), ["additionalContext"]);
    const geminiText = geminiJson.hookSpecificOutput.additionalContext;
    assert.ok(geminiText.includes("global/node-esm-pref"));
    assert.ok(geminiText.includes(`projects/${alphaSlug}/alpha-arch`));
    assert.ok(!geminiText.includes("OTHER_PROJECT_BETA_LEAK_GUARD"));
    assert.ok(!geminiText.includes("SECRET_BODY_ALPHA_NEVER_INJECTED_222"));

    // 4. Plain: accepts workspace or cwd -> JSON { additionalContext }
    const plainRes = runCliSync(["hook", "session-start", "--host", "plain"], {
      memdexHome,
      input: JSON.stringify({ workspace: realProjA }),
    });
    assert.equal(plainRes.status, 0, plainRes.stderr);
    const plainJson = JSON.parse(plainRes.stdout);
    assert.deepEqual(Object.keys(plainJson), ["additionalContext"]);
    assert.ok(plainJson.additionalContext.includes("global/node-esm-pref"));
    assert.ok(plainJson.additionalContext.includes(`projects/${alphaSlug}/alpha-arch`));
    assert.ok(!plainJson.additionalContext.includes("OTHER_PROJECT_BETA_LEAK_GUARD"));

    // 4b. Plain with empty stdin -> global-only
    const plainGlobalRes = runCliSync(["hook", "session-start", "--host", "plain"], {
      memdexHome,
      input: "",
    });
    assert.equal(plainGlobalRes.status, 0);
    const plainGlobalJson = JSON.parse(plainGlobalRes.stdout);
    assert.ok(plainGlobalJson.additionalContext.includes("global/node-esm-pref"));
    assert.ok(!plainGlobalJson.additionalContext.includes("alpha-arch"));
  });

  it("evaluates dual-threshold Dream reminder boundaries accurately without mutating state", () => {
    assert.equal(DREAM_MIN_UNSYNTHESIZED_SESSIONS, 5);
    assert.equal(DREAM_MIN_INTERVAL_HOURS, 24);

    const now = new Date("2026-11-22T12:00:00Z");
    const db = initDb(dbPath);
    try {
      // 0 conversations -> false
      let evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.shouldRemind, false);
      assert.equal(evalRes.unsynthesizedCount, 0);

      // 4 unsynthesized conversations, no prior dream -> false (4 < 5)
      for (let i = 1; i <= 4; i += 1) {
        seedConversation(db, `conv-u-${i}`);
      }
      evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.unsynthesizedCount, 4);
      assert.equal(evalRes.countGateMet, false);
      assert.equal(evalRes.timeGateMet, true);
      assert.equal(evalRes.shouldRemind, false);

      // 5th conversation already dreamed 25h ago with same message_count -> still only 4 unsynthesized
      seedConversation(db, "conv-dreamed-1", {
        messageCount: 2,
        dreamedAt: "2026-11-21T11:00:00Z", // 25h ago
        dreamedMsgCount: 2,
      });
      evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.unsynthesizedCount, 4);
      assert.equal(evalRes.timeGateMet, true);
      assert.equal(evalRes.shouldRemind, false);

      // Add a new message to conv-dreamed-1 (message_count=3 > dreamed_msg_count=2) -> re-counted as 5th unsynthesized!
      seedConversation(db, "conv-dreamed-1", {
        messageCount: 3,
        dreamedAt: "2026-11-21T11:00:00Z", // 25h ago
        dreamedMsgCount: 2,
      });
      evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.unsynthesizedCount, 5);
      assert.equal(evalRes.countGateMet, true);
      assert.equal(evalRes.timeGateMet, true);
      assert.equal(evalRes.shouldRemind, true);
      assert.ok(evalRes.reminderLine.includes("5 unsynthesized"));
      assert.ok(!evalRes.reminderLine.includes("\n"), "reminder must be a single line");

      // Exact 24h boundary (2026-11-21T12:00:00Z) -> true
      db.prepare("UPDATE conversations SET dreamed_at = ? WHERE id = ?").run(
        "2026-11-21T12:00:00Z",
        "conv-dreamed-1"
      );
      evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.shouldRemind, true);

      // Just under 24h (23h 59m 59s -> 2026-11-21T12:00:01Z) -> false
      db.prepare("UPDATE conversations SET dreamed_at = ? WHERE id = ?").run(
        "2026-11-21T12:00:01Z",
        "conv-dreamed-1"
      );
      evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.unsynthesizedCount, 5);
      assert.equal(evalRes.countGateMet, true);
      assert.equal(evalRes.timeGateMet, false);
      assert.equal(evalRes.shouldRemind, false);

      // 5 never-dreamed + 1 recently dreamed 2h ago -> count met, time NOT met -> false
      db.prepare("UPDATE conversations SET dreamed_at = '', dreamed_msg_count = 0 WHERE id = ?").run(
        "conv-dreamed-1"
      );
      seedConversation(db, "conv-recent-dream", {
        messageCount: 2,
        dreamedAt: "2026-11-22T10:00:00Z", // 2h ago
        dreamedMsgCount: 2,
      });
      evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.unsynthesizedCount, 5);
      assert.equal(evalRes.timeGateMet, false);
      assert.equal(evalRes.shouldRemind, false);

      // Remove recent dream -> 5 never-dreamed, no history -> true ("无历史整理时按可提示处理")
      db.prepare("DELETE FROM conversations WHERE id = ?").run("conv-recent-dream");
      evalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(evalRes.unsynthesizedCount, 5);
      assert.equal(evalRes.lastDreamedAt, null);
      assert.equal(evalRes.timeGateMet, true);
      assert.equal(evalRes.shouldRemind, true);

      // Verify state was NOT persisted/mutated by reminder evaluation
      const rows = db.prepare("SELECT dreamed_at, dreamed_msg_count FROM conversations").all();
      for (const r of rows) {
        assert.equal(r.dreamed_at, "");
        assert.equal(r.dreamed_msg_count, 0);
      }

      // CLI E2E: 5 unsynthesized conversations + 0 L2 notes -> emits 1-line reminder
      const cliNoNotesRemind = runCliSync(["hook", "session-start", "--host", "plain"], {
        memdexHome,
        input: "{}",
      });
      assert.equal(cliNoNotesRemind.status, 0);
      const cliNoNotesJson = JSON.parse(cliNoNotesRemind.stdout);
      assert.match(cliNoNotesJson.additionalContext, /^\[Memdex\] Reminder: 5 unsynthesized session\(s\)/);

      // CLI E2E: add a recent dream (2h ago) + 0 L2 notes -> silent {}
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      seedConversation(db, "conv-cli-recent", {
        messageCount: 2,
        dreamedAt: twoHoursAgo,
        dreamedMsgCount: 2,
      });
      const cliRecentSilent = runCliSync(["hook", "session-start", "--host", "plain"], {
        memdexHome,
        input: "{}",
      });
      assert.equal(cliRecentSilent.status, 0);
      assert.deepEqual(JSON.parse(cliRecentSilent.stdout), {});

      // CLI E2E: move dream timestamp to 25h ago -> reminder appears again
      const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE conversations SET dreamed_at = ? WHERE id = ?").run(
        twentyFiveHoursAgo,
        "conv-cli-recent"
      );
      const cliOldRemind = runCliSync(["hook", "session-start", "--host", "plain"], {
        memdexHome,
        input: "{}",
      });
      assert.equal(cliOldRemind.status, 0);
      assert.match(
        JSON.parse(cliOldRemind.stdout).additionalContext,
        /^\[Memdex\] Reminder: 5 unsynthesized session\(s\)/
      );

      // CLI E2E: drop to 4 unsynthesized + 0 L2 notes -> silent {}
      db.prepare("DELETE FROM conversations WHERE id = ?").run("conv-u-1");
      const cliFourSilent = runCliSync(["hook", "session-start", "--host", "plain"], {
        memdexHome,
        input: "{}",
      });
      assert.equal(cliFourSilent.status, 0);
      assert.deepEqual(JSON.parse(cliFourSilent.stdout), {});
    } finally {
      db.close();
    }
  });

  it("enforces <=150 lines AND <=8192 UTF-8 bytes including the Dream reminder line at the end", () => {
    const projA = "/Users/dev/projects/budget-alpha";
    const projB = "/Users/dev/projects/budget-beta";

    const db = initDb(dbPath);
    try {
      // 60 global notes
      for (let i = 1; i <= 60; i += 1) {
        const day = String(((i - 1) % 28) + 1).padStart(2, "0");
        upsertMemory(db, {
          scope: "global",
          type: "user",
          slug: `g-note-${String(i).padStart(3, "0")}`,
          name: `全局规范 ${i}`,
          description: `用于压测全局索引上限与合并预算控制的中文描述条目 ${i}`,
          content: `GLOBAL_BODY_SECRET_${i}`,
          updated: `2026-10-${day}T10:00:00Z`,
          notesDir,
        });
      }

      // 115 verbose CJK project A notes
      for (let i = 1; i <= 115; i += 1) {
        const day = String(((i - 1) % 28) + 1).padStart(2, "0");
        upsertMemory(db, {
          scope: "project",
          workspace: projA,
          type: "project",
          slug: `p-note-${String(i).padStart(3, "0")}`,
          name: `项目架构约束条目 ${i}（含多字节中文字符）`,
          description: `较长的中文摘要信息用于触发八千一百九十二字节硬上限且保证末尾提醒行仍能完整保留 ${i}`,
          content: `PROJA_BODY_SECRET_${i}`,
          updated: `2026-11-${day}T10:00:00Z`,
          notesDir,
        });
      }

      // Project B note (must never leak)
      upsertMemory(db, {
        scope: "project",
        workspace: projB,
        type: "project",
        slug: "beta-only",
        name: "Beta 机密",
        description: "BETA_BUDGET_LEAK_MARKER",
        content: "BETA_BODY_SECRET",
        notesDir,
      });

      // 5 unsynthesized conversations (no prior dream -> reminder triggers)
      for (let i = 1; i <= 5; i += 1) {
        seedConversation(db, `conv-budget-${i}`, { workspace: projB });
      }
    } finally {
      db.close();
    }

    // Via CLI SessionStart (Antigravity)
    const res = runCliSync(["hook", "session-start", "--host", "antigravity"], {
      memdexHome,
      input: JSON.stringify({ conversationId: "conv-now", workspacePaths: [projA] }),
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    const injected = parsed.injectSteps[0].systemMessage.systemMessage;
    const lines = injected.split("\n");
    const bytes = Buffer.byteLength(injected, "utf8");

    assert.ok(lines.length <= 150, `expected <=150 lines including reminder, got ${lines.length}`);
    assert.ok(bytes <= 8192, `expected <=8192 UTF-8 bytes including reminder, got ${bytes}`);
    assert.ok(!injected.includes("\uFFFD"), "must not corrupt multibyte UTF-8 characters");
    assert.match(lines[lines.length - 1], /^\[Memdex\] Reminder: 5 unsynthesized session\(s\)/);
    assert.ok(!injected.includes("BETA_BUDGET_LEAK_MARKER"), "must not leak project B L2 notes");
    assert.ok(!injected.includes("GLOBAL_BODY_SECRET_"), "must not read L2 global note body");
    assert.ok(!injected.includes("PROJA_BODY_SECRET_"), "must not read L2 project note body");

    // Also test line-cap specifically (short ASCII lines where 50 + 1 + 100 = 151 lines < 8192 bytes) + reminder!
    const shortHome = path.join(tmpDir, "short-home");
    const shortDbPath = path.join(shortHome, "memory.db");
    const shortNotesDir = path.join(shortHome, "notes");
    const shortDb = initDb(shortDbPath);
    try {
      for (let i = 1; i <= 55; i += 1) {
        upsertMemory(shortDb, {
          scope: "global",
          type: "user",
          slug: `g${i}`,
          name: `g${i}`,
          description: `d${i}`,
          content: "body",
          notesDir: shortNotesDir,
        });
      }
      for (let i = 1; i <= 105; i += 1) {
        upsertMemory(shortDb, {
          scope: "project",
          workspace: projA,
          type: "project",
          slug: `p${i}`,
          name: `p${i}`,
          description: `d${i}`,
          content: "body",
          notesDir: shortNotesDir,
        });
      }
      for (let i = 1; i <= 5; i += 1) {
        seedConversation(shortDb, `conv-short-${i}`);
      }
    } finally {
      shortDb.close();
    }

    const ctx = buildSessionStartContext({
      workspace: projA,
      notesDir: shortNotesDir,
      dbPath: shortDbPath,
      now: new Date("2026-11-22T12:00:00Z"),
    });
    assert.ok(ctx.lines <= 150, `expected <=150 lines, got ${ctx.lines}`);
    assert.ok(ctx.bytes <= 8192, `expected <=8192 bytes, got ${ctx.bytes}`);
    const ctxLines = ctx.text.split("\n");
    assert.match(ctxLines[ctxLines.length - 1], /^\[Memdex\] Reminder: 5 unsynthesized session\(s\)/);
  });

  it("fails quietly with valid {} JSON on malformed stdin, unknown hosts/subcommands, and degrades gracefully on corrupt DB", () => {
    for (const host of ["antigravity", "claude", "gemini", "plain"]) {
      const badRes = runCliSync(["hook", "session-start", "--host", host], {
        memdexHome,
        input: "{not-valid-json",
      });
      assert.equal(badRes.status, 0);
      assert.equal(badRes.stdout.trim(), "{}");
    }

    const badStop = runCliSync(["hook", "stop", "--host", "antigravity"], {
      memdexHome,
      input: "{broken",
    });
    assert.equal(badStop.status, 0);
    assert.equal(badStop.stdout.trim(), "{}");

    const unknownHost = runCliSync(["hook", "session-start", "--host", "unknown-host"], {
      memdexHome,
      input: "{}",
    });
    assert.equal(unknownHost.status, 0);
    assert.equal(unknownHost.stdout.trim(), "{}");

    const unknownHook = runCliSync(["hook", "bogus-event"], {
      memdexHome,
      input: "{}",
    });
    assert.equal(unknownHook.status, 0);
    assert.equal(unknownHook.stdout.trim(), "{}");

    assert.ok(fs.existsSync(path.join(memdexHome, "hook.log")), "errors should be recorded in isolated hook.log");

    // Corrupt DB with valid global MEMORY.md -> SessionStart degrades gracefully and still serves MEMORY.md!
    const corruptHome = path.join(tmpDir, "corrupt-home");
    fs.mkdirSync(path.join(corruptHome, "notes", "global"), { recursive: true });
    fs.writeFileSync(
      path.join(corruptHome, "notes", "global", "MEMORY.md"),
      "# Memdex Global Memory Index\n- [user] `global/ok` — OK: Valid index despite corrupt DB (2026-11-22)\n",
      "utf8"
    );
    fs.writeFileSync(path.join(corruptHome, "memory.db"), "NOT_A_VALID_SQLITE_FILE_BYTES", "utf8");

    const degradeRes = runCliSync(["hook", "session-start", "--host", "plain"], {
      memdexHome: corruptHome,
      input: "{}",
    });
    assert.equal(degradeRes.status, 0);
    const degradeJson = JSON.parse(degradeRes.stdout);
    assert.ok(degradeJson.additionalContext.includes("global/ok"));
  });

  it("skips Antigravity memory injection and Stop persistence in a read-only workspace", () => {
    const workspace = path.join(tmpDir, "read-only");
    const markerDir = path.join(workspace, ".agents");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "memdex-readonly"), "");
    const globalNotes = path.join(memdexHome, "notes", "global");
    fs.mkdirSync(globalNotes, { recursive: true });
    fs.writeFileSync(
      path.join(globalNotes, "MEMORY.md"),
      "# Memdex Global Memory Index\n- [user] `global/example` — Example global context (2026-11-22)\n",
    );
    const transcriptPath = path.join(tmpDir, "transcript.jsonl");
    writeJsonl(transcriptPath, [
      { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nTest conversation\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", content: "Test answer" },
    ]);
    const input = JSON.stringify({ workspacePaths: [workspace], conversationId: "read-only-test", transcriptPath });
    for (const hook of ["session-start", "stop"]) {
      const result = runCliSync(["hook", hook, "--host", "antigravity"], { memdexHome, input });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {}, hook);
    }
    const db = initDb(dbPath);
    try {
      assert.equal(db.prepare("SELECT id FROM conversations WHERE id = ?").get("read-only-test"), undefined);
    } finally {
      db.close();
    }
  });

  it("supports unified CLI hook stop (default antigravity + non-antigravity no-op), sync, search, list, and legacy harness --hook", () => {
    const brainDir = path.join(tmpDir, "brain");
    const logFile = path.join(brainDir, "conv-stop-cli", ".system_generated", "logs", "transcript.jsonl");
    writeJsonl(logFile, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-22T09:00:00Z",
        content: "<USER_REQUEST>\n验证统一 CLI 的 Stop Hook 与检索入口\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T09:00:05Z",
        content: "已通过统一 memdex CLI 完成增量同步。",
      },
    ]);

    // 1. Default host on `hook stop` is antigravity
    const stopRes = runCliSync(["hook", "stop"], {
      memdexHome,
      input: JSON.stringify({
        conversationId: "conv-stop-cli",
        transcriptPath: logFile,
        workspacePaths: ["/Users/dev/projects/unified-cli"],
      }),
    });
    assert.equal(stopRes.status, 0, stopRes.stderr);
    assert.equal(stopRes.stdout.trim(), "{}");

    // 2. Non-antigravity Stop hook is a quiet {} no-op (Task 4 boundary)
    const claudeStopRes = runCliSync(["hook", "stop", "--host", "claude"], {
      memdexHome,
      input: JSON.stringify({
        session_id: "claude-stop-1",
        transcript_path: logFile,
        cwd: "/Users/dev/projects/claude-ignored",
      }),
    });
    assert.equal(claudeStopRes.status, 0);
    assert.equal(claudeStopRes.stdout.trim(), "{}");

    const db = initDb(dbPath);
    try {
      const hits = searchMessages(db, "Stop Hook 与检索入口");
      assert.equal(hits.length, 1);
      assert.equal(hits[0].conversationId, "conv-stop-cli");
      assert.equal(hits[0].workspace, "/Users/dev/projects/unified-cli");
      const claudeConv = db.prepare("SELECT * FROM conversations WHERE id = ?").get("claude-stop-1");
      assert.equal(claudeConv, undefined);
    } finally {
      db.close();
    }

    // 3. Unified CLI `sync`, `search`, and `list` using isolated MEMDEX_HOME + synthetic MEMDEX_BRAIN_DIRS
    const logFile2 = path.join(brainDir, "conv-sync-cli", ".system_generated", "logs", "transcript.jsonl");
    writeJsonl(logFile2, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-22T10:00:00Z",
        content: "<USER_REQUEST>\n测试 memdex sync 命令行增量扫描\n</USER_REQUEST>",
      },
    ]);

    const syncRes = runCliSync(["sync"], {
      memdexHome,
      env: { MEMDEX_BRAIN_DIRS: brainDir },
    });
    assert.equal(syncRes.status, 0, syncRes.stderr);
    const syncJson = JSON.parse(syncRes.stdout);
    assert.equal(syncJson.scanned, 2);
    assert.equal(syncJson.updated, 1);
    assert.equal(syncJson.skipped, 1);

    const searchRes = runCliSync(["search", "命令行增量扫描"], { memdexHome });
    assert.equal(searchRes.status, 0, searchRes.stderr);
    assert.ok(searchRes.stdout.includes("conv-sync-cli"));

    const listRes = runCliSync(["list", "--limit", "5"], { memdexHome });
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.ok(listRes.stdout.includes("conv-sync-cli"));
    assert.ok(listRes.stdout.includes("conv-stop-cli"));

    // 4. Legacy `scripts/harness.mjs --hook` compatibility
    const legacyLog = path.join(brainDir, "conv-legacy-stop", ".system_generated", "logs", "transcript.jsonl");
    writeJsonl(legacyLog, [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-22T11:00:00Z",
        content: "<USER_REQUEST>\n兼容旧版 harness Stop Hook\n</USER_REQUEST>",
      },
    ]);
    const legacyRes = spawnSync(process.execPath, [HARNESS_PATH, "--hook"], {
      input: JSON.stringify({
        conversationId: "conv-legacy-stop",
        transcriptPath: legacyLog,
        workspacePaths: ["/Users/dev/projects/legacy-ok"],
      }),
      encoding: "utf8",
      env: buildIsolatedEnv(memdexHome),
    });
    assert.equal(legacyRes.status, 0, legacyRes.stderr);
    assert.equal(legacyRes.stdout.trim(), "{}");
  });

  it("never falls back to writable SQLite open on TOCTOU deletion, works on active/closed WAL, and skips reminders on older experimental SQLite", () => {
    assert.equal(supportsSqliteReadOnly("22.5.0"), false);
    assert.equal(supportsSqliteReadOnly("22.11.0"), false);
    assert.equal(supportsSqliteReadOnly("22.11.9"), false);
    assert.equal(supportsSqliteReadOnly("22.12.0"), true);
    assert.equal(supportsSqliteReadOnly("22.14.0"), true);
    assert.equal(supportsSqliteReadOnly("23.0.0"), false);
    assert.equal(supportsSqliteReadOnly("23.1.0"), false);
    assert.equal(supportsSqliteReadOnly("23.2.0"), true);
    assert.equal(supportsSqliteReadOnly("24.1.0"), true);
    assert.equal(supportsSqliteReadOnly(""), false);

    const now = new Date("2026-11-22T12:00:00Z");
    const db = initDb(dbPath);
    try {
      upsertMemory(db, {
        scope: "global",
        type: "user",
        slug: "readonly-guard-note",
        name: "只读保护测试",
        description: "验证 SessionStart 绝不创建空数据库",
        content: "Body never injected",
        notesDir,
      });
      for (let i = 1; i <= 5; i += 1) {
        seedConversation(db, `conv-wal-${i}`);
      }

      // 1. Active WAL connection open -> readOnly reminder still works
      const activeWalRes = evaluateDreamReminder({ dbPath, now });
      assert.equal(activeWalRes.shouldRemind, true);
      assert.equal(activeWalRes.unsynthesizedCount, 5);
    } finally {
      db.close();
    }

    // 2. Closed WAL DB -> readOnly reminder still works (unit + CLI)
    const closedWalRes = evaluateDreamReminder({ dbPath, now });
    assert.equal(closedWalRes.shouldRemind, true);
    assert.equal(closedWalRes.unsynthesizedCount, 5);

    const cliWalRes = runCliSync(["hook", "session-start", "--host", "plain"], {
      memdexHome,
      input: "{}",
    });
    assert.equal(cliWalRes.status, 0, cliWalRes.stderr);
    const cliWalText = JSON.parse(cliWalRes.stdout).additionalContext;
    assert.ok(cliWalText.includes("global/readonly-guard-note"));
    assert.match(cliWalText.split("\n").at(-1), /^\[Memdex\] Reminder: 5 unsynthesized session\(s\)/);

    // 3. Older experimental SQLite -> keeps L2 index, skips database reminder
    const legacyNodeCtx = buildSessionStartContext({
      workspace: "",
      notesDir,
      dbPath,
      now,
      nodeVersion: "22.11.0",
    });
    assert.equal(legacyNodeCtx.dream.shouldRemind, false);
    assert.equal(legacyNodeCtx.empty, false);
    assert.ok(legacyNodeCtx.text.includes("global/readonly-guard-note"));
    assert.ok(!legacyNodeCtx.text.includes("[Memdex] Reminder:"));

    // 4. Deterministic TOCTOU: fs.existsSync removes memory.db on first check and returns true ->
    //    strict readOnly open fails cleanly, NEVER creates a 0-byte memory.db, stays quiet, and still injects L2 index!
    const origExistsSync = fs.existsSync;
    let triggeredToctou = false;
    fs.existsSync = (targetPath) => {
      if (!triggeredToctou && path.resolve(String(targetPath)) === path.resolve(dbPath)) {
        triggeredToctou = true;
        for (const suffix of ["", "-wal", "-shm"]) {
          fs.rmSync(`${dbPath}${suffix}`, { force: true });
        }
        return true;
      }
      return origExistsSync(targetPath);
    };

    try {
      const toctouCtx = buildSessionStartContext({
        workspace: "",
        notesDir,
        dbPath,
        now,
      });
      assert.equal(triggeredToctou, true, "TOCTOU wrapper must have intercepted dbPath check");
      assert.equal(toctouCtx.dream.shouldRemind, false);
      assert.equal(toctouCtx.dream.unsynthesizedCount, 0);
      assert.ok(toctouCtx.text.includes("global/readonly-guard-note"), "L2 index must still inject cleanly");
      assert.ok(!toctouCtx.text.includes("[Memdex] Reminder:"));
    } finally {
      fs.existsSync = origExistsSync;
    }

    assert.equal(fs.existsSync(dbPath), false, "strict readOnly failure must NEVER create a 0-byte memory.db");
    assert.equal(
      fs.existsSync(path.join(memdexHome, "hook.log")),
      false,
      "missing DB during TOCTOU should stay completely quiet"
    );
  });

  it("keeps MCP stdout strictly protocol-only via both `memdex mcp` and legacy `scripts/mcp-server.mjs`", async () => {
    const env = buildIsolatedEnv(memdexHome);
    await verifyMcpEntrypoint([CLI_PATH, "mcp"], env);
    await verifyMcpEntrypoint([MCP_SERVER_PATH], env);
  });
});
