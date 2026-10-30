import { appendFileSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Keep generated logs and metadata out of directories another user can replace. */
export function ensurePrivateDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  validateDirectoryTree(absolute, true);
}

function unsafe(directory: string): never {
  throw new Error(`Unsafe output directory: ${directory}; use a directory you own that is not writable or replaceable by other users`);
}

/** Check parents before creating children. A safe leaf in an attacker-owned parent is replaceable. */
function validateDirectoryTree(absolute: string, requireUserOwnedLeaf: boolean): boolean {
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  let protectedByPrivateParent = false;
  const uid = process.getuid?.();
  for (let i = -1; i < components.length; i++) {
    if (i >= 0) current = path.join(current, components[i]!);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); } catch (creationError) {
        if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") throw creationError;
      }
      stat = lstatSync(current);
    }
    const isLeaf = i === components.length - 1;
    if (stat.isSymbolicLink()) {
      if (isLeaf || (uid !== undefined && stat.uid !== uid && stat.uid !== 0)) unsafe(current);
      // System aliases such as macOS /var must resolve through safe parents too.
      protectedByPrivateParent = validateDirectoryTree(realpathSync(current), false);
      continue;
    }
    if (!stat.isDirectory()) unsafe(current);
    if (uid !== undefined) {
      if (stat.uid !== uid && stat.uid !== 0) unsafe(current);
      const rootOwnedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (!protectedByPrivateParent && (stat.mode & 0o022) !== 0 && !rootOwnedSticky) unsafe(current);
      if (isLeaf && requireUserOwnedLeaf && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) unsafe(current);
      if (stat.uid === uid && (stat.mode & 0o011) === 0) protectedByPrivateParent = true;
    }
  }
  return protectedByPrivateParent;
}

/** Exclusive creation never follows a pre-existing symlink or truncates a file. */
export function openPrivateFile(file: string): number {
  ensurePrivateDirectory(path.dirname(file));
  return openSync(file, "wx", 0o600);
}

export function writePrivateFile(file: string, data: string | Uint8Array): void {
  const fd = openPrivateFile(file);
  try { writeFileSync(fd, data); } catch (error) {
    unlinkSync(file);
    throw error;
  } finally { closeSync(fd); }
}

/** Append through a checked descriptor; never recreate a removed spill file. */
export function appendPrivateFile(file: string, data: Uint8Array): void {
  ensurePrivateDirectory(path.dirname(file));
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error(`Unsafe output file: ${file}`);
    }
    appendFileSync(fd, data);
  } finally { closeSync(fd); }
}

/** Re-recording replaces the directory entry, never the target of a symlink. */
export function replacePrivateFile(file: string, data: string | Uint8Array): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writePrivateFile(temporary, data);
  try { renameSync(temporary, file); } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
