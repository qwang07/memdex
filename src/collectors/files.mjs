import fs from "node:fs";

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
