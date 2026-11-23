import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { supportsSqliteReadOnly } from "../db.mjs";
import { normalizeWorkspace } from "../paths.mjs";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function* lengthDelimitedFields(data) {
  let offset = 0;

  function readVarint() {
    let value = 0;
    for (let shift = 0; shift < 70 && offset < data.length; shift += 7) {
      const byte = data[offset++];
      if (shift === 63 && byte > 1) break;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Invalid protobuf varint");
  }

  while (offset < data.length) {
    const tag = readVarint();
    if (tag < 8 || tag > 0xffffffff) throw new Error("Invalid protobuf tag");

    switch (tag % 8) {
      case 0:
        readVarint();
        break;
      case 1:
        offset += 8;
        break;
      case 2: {
        const size = readVarint();
        const end = offset + size;
        if (end > data.length) throw new Error("Truncated protobuf field");
        yield [Math.floor(tag / 8), data.subarray(offset, end)];
        offset = end;
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        throw new Error("Unsupported protobuf wire type");
    }
    if (offset > data.length) throw new Error("Truncated protobuf field");
  }
}

function localWorkspace(data) {
  const uri = new URL(utf8.decode(data));
  if (uri.protocol !== "file:" || uri.host || uri.search || uri.hash) {
    throw new Error("Expected a local workspace file URI");
  }
  const workspace = fileURLToPath(uri);
  if (!path.isAbsolute(workspace) || workspace.includes("\0")) {
    throw new Error("Invalid local workspace path");
  }
  return normalizeWorkspace(workspace);
}

function decodeWorkspace(data) {
  // CortexTrajectoryMetadata: workspaces = 1, workspace_uris = 7.
  // CortexWorkspaceMetadata: workspace_folder_absolute_uri = 1.
  const workspaces = new Set();
  for (const [field, value] of lengthDelimitedFields(data)) {
    if (field === 7) workspaces.add(localWorkspace(value));
    if (field === 1) {
      for (const [nestedField, nestedValue] of lengthDelimitedFields(value)) {
        if (nestedField === 1) workspaces.add(localWorkspace(nestedValue));
      }
    }
  }
  return workspaces.size === 1 ? workspaces.values().next().value : null;
}

export function readAntigravityWorkspace(brainDir, sessionId) {
  if (!supportsSqliteReadOnly()) return null;

  const conversations = path.resolve(brainDir, "..", "conversations");
  const filename = path.join(conversations, sessionId + ".db");
  let db;
  try {
    if (!fs.lstatSync(conversations).isDirectory() || !fs.lstatSync(filename).isFile()) return null;
    db = new DatabaseSync(filename, { readOnly: true });
    const rows = db.prepare(`
      SELECT data FROM trajectory_metadata_blob
      WHERE (SELECT count(*) FROM trajectory_meta) = 1
        AND EXISTS (SELECT 1 FROM trajectory_meta WHERE cascade_id = ?)
      LIMIT 2
    `).all(sessionId);
    return rows.length === 1 && rows[0].data instanceof Uint8Array
      ? decodeWorkspace(rows[0].data)
      : null;
  } catch {
    // Native metadata is optional. An unreadable or unfamiliar file leaves transcript attribution in place.
    return null;
  } finally {
    db?.close();
  }
}
