import fs from "node:fs";
import path from "node:path";

import { expandHome } from "../paths.mjs";

export function transcriptRoots(override, fallback) {
  const roots = override === undefined ? [fallback] : override.split(path.delimiter);
  return [...new Set(roots.map(expandHome).filter(Boolean).map((dir) => path.resolve(dir)))];
}

export function directoryEntries(dirname) {
  try {
    return fs.lstatSync(dirname).isDirectory() ? fs.readdirSync(dirname, { withFileTypes: true }) : [];
  } catch {
    return [];
  }
}

export function newestTranscripts(files) {
  return files.sort((a, b) => {
    const byStat = b.fileMtime - a.fileMtime || b.fileSize - a.fileSize;
    if (byStat !== 0) return byStat;
    if (a.sourcePath < b.sourcePath) return -1;
    return Number(a.sourcePath > b.sourcePath);
  });
}

const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;

export function transcriptSnapshot(sourcePath) {
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile()) return null;
    fs.accessSync(sourcePath, fs.constants.R_OK);
    return {
      sourcePath,
      fileMtime: stat.mtimeMs,
      fileSize: stat.size,
      device: stat.dev,
      inode: stat.ino,
    };
  } catch {
    return null;
  }
}

function matchesSnapshot(stat, file) {
  return stat.isFile() && stat.dev === file.device && stat.ino === file.inode &&
    stat.mtimeMs === file.fileMtime && stat.size === file.fileSize;
}

export function readTranscript(file) {
  let fd;
  try {
    if (!O_NOFOLLOW && !matchesSnapshot(fs.lstatSync(file.sourcePath), file)) return null;
    fd = fs.openSync(file.sourcePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!matchesSnapshot(fs.fstatSync(fd), file)) return null;
    const raw = fs.readFileSync(fd, "utf8");
    return matchesSnapshot(fs.fstatSync(fd), file)
      ? raw
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
