#!/usr/bin/env node
/**
 * Unified Memdex CLI entrypoint.
 *
 * Commands:
 *   memdex mcp
 *   memdex sync [--force]
 *   memdex ingest --source retinue
 *   memdex hook session-start [--host antigravity|claude|gemini|plain] [--workspace <path>]
 *   memdex hook stop [--host antigravity]
 *   memdex search <query> [--project <p>] [--source <s>] [--layer all|notes|conversations] [--limit <n>]
 *   memdex list [--project <p>] [--source <s>] [--limit <n>]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  initDb,
  listConversations,
  logHookError,
  resolveDbPath,
  resolveNotesDir,
  searchHybrid,
  syncLocalConversations,
  syncNotesFromDisk,
} from "../scripts/harness.mjs";
import { ingestConversation } from "../src/ingest.mjs";
import {
  DEFAULT_HOOK_HOST,
  runSessionStartHook,
  runStopHookAdapter,
} from "../src/hooks.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USAGE = `Usage:
  memdex mcp
  memdex sync [--force]
  memdex ingest --source retinue
  memdex hook session-start [--host antigravity|claude|gemini|plain] [--workspace <path>]
  memdex hook stop [--host antigravity]
  memdex search <query> [--project <p>] [--source <s>] [--layer all|notes|conversations] [--limit <n>]
  memdex list [--project <p>] [--source <s>] [--limit <n>]
`;

function getPackageVersion() {
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function parseFlags(argv) {
  const flags = {
    force: false,
    host: "",
    workspace: "",
    project: "",
    source: "",
    layer: "all",
    limit: 5,
    help: false,
    version: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--host" && i + 1 < argv.length) {
      flags.host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      flags.host = arg.slice("--host=".length);
    } else if (arg === "--workspace" && i + 1 < argv.length) {
      flags.workspace = argv[++i];
    } else if (arg.startsWith("--workspace=")) {
      flags.workspace = arg.slice("--workspace=".length);
    } else if (arg === "--project" && i + 1 < argv.length) {
      flags.project = argv[++i];
    } else if (arg.startsWith("--project=")) {
      flags.project = arg.slice("--project=".length);
    } else if (arg === "--source" && i + 1 < argv.length) {
      flags.source = argv[++i];
    } else if (arg.startsWith("--source=")) {
      flags.source = arg.slice("--source=".length);
    } else if (arg === "--layer" && i + 1 < argv.length) {
      flags.layer = argv[++i];
    } else if (arg.startsWith("--layer=")) {
      flags.layer = arg.slice("--layer=".length);
    } else if (arg === "--limit" && i + 1 < argv.length) {
      flags.limit = Number(argv[++i]) || 5;
    } else if (arg.startsWith("--limit=")) {
      flags.limit = Number(arg.slice("--limit=".length)) || 5;
    } else {
      flags.positional.push(arg);
    }
  }

  return flags;
}

function handleHookCommand(subcommand, flags) {
  const host = flags.host || DEFAULT_HOOK_HOST;
  if (subcommand === "session-start") {
    const response = runSessionStartHook({
      host,
      workspace: flags.workspace,
    });
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return 0;
  }

  if (subcommand === "stop") {
    const response = runStopHookAdapter({ host });
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return 0;
  }

  // Quietly fail with valid JSON on unknown hook subcommand so hosts are never broken.
  logHookError(new Error(`Unknown hook subcommand: '${subcommand || ""}'`));
  process.stdout.write("{}\n");
  return 0;
}

function handleSyncCommand(flags) {
  const db = initDb();
  try {
    const stats = syncLocalConversations(db, { force: flags.force });
    const notes = syncNotesFromDisk(db);
    process.stdout.write(
      `${JSON.stringify(
        {
          dbPath: resolveDbPath(),
          notesDir: resolveNotesDir(),
          ...stats,
          notes,
        },
        null,
        2
      )}\n`
    );
    return 0;
  } finally {
    db.close();
  }
}

function handleIngestCommand(rest, flags) {
  if (flags.source !== "retinue" || rest.length > 0) {
    process.stderr.write("Usage: memdex ingest --source retinue < snapshot.json\n");
    return 1;
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("Error: Expected one JSON conversation snapshot on stdin.\n");
    return 1;
  }

  try {
    const result = ingestConversation(input);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write("Error: " + error.message + "\n");
    return 1;
  }
}

function handleSearchCommand(rest, flags) {
  const query = rest.join(" ").trim();
  if (!query) {
    process.stderr.write("Error: Please provide a search query.\n");
    return 1;
  }

  const validLayers = new Set(["all", "notes", "conversations"]);
  const layer = validLayers.has(flags.layer) ? flags.layer : "all";

  const db = initDb();
  try {
    const { notes, messages } = searchHybrid(db, query, {
      project: flags.project,
      source: flags.source,
      layer,
      limit: flags.limit,
    });

    if (notes.length === 0 && messages.length === 0) {
      process.stdout.write(`No results found for: ${query}\n`);
      return 0;
    }

    for (const note of notes) {
      const staleTag = note.stalenessNote ? ` | WARN: ${note.stalenessNote}` : "";
      process.stdout.write(
        `[L2:${note.type}] ${note.id} (${note.updated}, ${note.ageLabel})${staleTag}\n`
      );
      process.stdout.write(`${note.name} — ${note.description}\n${"-".repeat(50)}\n`);
    }

    for (const item of messages) {
      const staleTag = item.stalenessNote ? ` | WARN: ${item.stalenessNote}` : "";
      process.stdout.write(
        `[${item.timestamp} (${item.ageLabel})] [${item.source}] ${item.workspace} | ${item.role} (conv=${item.conversationId}, rank=${item.rank.toFixed(2)})${staleTag}\n`
      );
      process.stdout.write(`${item.snippet}\n${"-".repeat(50)}\n`);
    }

    return 0;
  } finally {
    db.close();
  }
}

function handleListCommand(flags) {
  const db = initDb();
  try {
    const convs = listConversations(db, {
      limit: flags.limit,
      project: flags.project,
      source: flags.source,
    });
    for (const item of convs) {
      process.stdout.write(
        `[${item.lastUpdated} (${item.ageLabel})] [${item.source}] ${item.conversationId} | ${item.workspace} (${item.messageCount} msgs) — ${item.summary}\n`
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const [command, ...rest] = flags.positional;

  // Hook commands must always stay quiet and emit valid JSON even if `--help` is accidentally passed.
  if (command === "hook") {
    return handleHookCommand(rest[0], flags);
  }

  if (flags.help || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (flags.version) {
    process.stdout.write(`${getPackageVersion()}\n`);
    return 0;
  }

  if (command === "mcp") {
    const { startMcpServer } = await import("../src/mcp.mjs");
    await startMcpServer();
    return null;
  }

  if (command === "sync" || command === "update") {
    return handleSyncCommand(flags);
  }

  if (command === "ingest") {
    return handleIngestCommand(rest, flags);
  }

  if (command === "search") {
    return handleSearchCommand(rest, flags);
  }

  if (command === "list") {
    return handleListCommand(flags);
  }

  process.stderr.write(USAGE);
  return 1;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === __filename;
  }
}

if (isDirectExecution()) {
  const exitCode = await runCli(process.argv.slice(2));
  if (typeof exitCode === "number" && exitCode !== 0) {
    process.exit(exitCode);
  }
}
