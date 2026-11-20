import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One compatibility boundary for every runner setting, including the agy adapter.
// An explicitly empty new value also wins, allowing a legacy default to be cleared.
export const duetEnv = (suffix) => process.env[`AGENT_DUET_${suffix}`] ?? process.env[`CODEX_DUET_${suffix}`];

function entry(file) {
  try { return fs.lstatSync(file); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Written into the old directory just before the move and removed once the compatibility
// link exists, so a later call can tell an interrupted move from a fresh installation.
export const MIGRATING = '.agent-duet-migrating';
// Records that a directory holding no marker was checked and needs no link.
const NO_LEGACY_LINK = '.agent-duet-no-legacy-link';
const READ_ONLY = ['EACCES', 'EPERM', 'EROFS'];

// Sessions from before the rename keep absolute paths under the old directory (a build's
// worktree, for one). Moves made before the marker existed are recognised by those paths.
function namesLegacyPaths(current, legacy) {
  const needle = path.resolve(legacy) + path.sep;
  let names;
  try { names = fs.readdirSync(current); } catch { return false; }
  return names.some((name) => {
    try { return fs.readFileSync(path.join(current, name, 'state.json'), 'utf8').includes(needle); } catch { return false; }
  });
}

// The link is a convenience for old paths: a read-only state home must not stop the runner.
function linkLegacy(current, legacy) {
  try {
    fs.symlinkSync(path.resolve(current), legacy, 'dir');
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return true;
    if (READ_ONLY.includes(err.code)) return false;
    throw err;
  }
}

export function stateRoot() {
  const explicit = duetEnv('HOME');
  if (explicit) return explicit;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const current = path.join(base, 'agent-duet');
  const legacy = path.join(base, 'codex-duet');
  const marker = path.join(current, MIGRATING);
  const destination = entry(current);
  if (destination) {
    // An independent old root (including a dangling link) wins its own name and is never replaced.
    if (!destination.isDirectory() || entry(legacy)) return current;
    // The old name is free. Recreate the link only after an interrupted move, never on a fresh
    // installation or after the owner removed the link from a directory that does not need it.
    if (!entry(marker)) {
      if (entry(path.join(current, NO_LEGACY_LINK)) || !namesLegacyPaths(current, legacy)) {
        try { fs.writeFileSync(path.join(current, NO_LEGACY_LINK), ''); } catch {}
        return current;
      }
    }
  } else {
    if (!entry(legacy)?.isDirectory()) return current; // never rename a symlink
    try {
      fs.writeFileSync(path.join(legacy, MIGRATING), new Date().toISOString());
    } catch (err) {
      if (READ_ONLY.includes(err.code)) return legacy; // cannot move it: keep reading the old root in place
      if (err.code !== 'ENOENT') throw err; // ENOENT: a peer moved it already
    }
    try {
      fs.renameSync(legacy, current);
    } catch (err) {
      // A peer may have moved it between our lstat and rename; the old name may then already be
      // its link (EISDIR on macOS when renaming that link onto the directory). Do not hide other errors.
      if (!['EEXIST', 'ENOENT', 'ENOTEMPTY', 'EISDIR'].includes(err.code) || !entry(current)?.isDirectory()) throw err;
    }
  }
  // Old processes, saved paths and Git's worktree metadata still name the old directory.
  if (linkLegacy(current, legacy)) fs.rmSync(marker, { force: true });
  return current;
}
