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

export function stateRoot() {
  const explicit = duetEnv('HOME');
  if (explicit) return explicit;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const current = path.join(base, 'agent-duet');
  const legacy = path.join(base, 'codex-duet');
  const destination = entry(current);
  if (destination) {
    // A previous invocation may have stopped after rename. An independent old
    // root (including a dangling link) wins its own name and is never replaced.
    if (!destination.isDirectory() || entry(legacy)) return current;
  } else {
    if (!entry(legacy)?.isDirectory()) return current; // never rename a symlink
    try {
      fs.renameSync(legacy, current);
    } catch (err) {
      // A peer may have moved it between our lstat and rename. Do not hide other errors.
      if (!['EEXIST', 'ENOENT', 'ENOTEMPTY'].includes(err.code) || !entry(current)?.isDirectory()) throw err;
    }
  }
  try {
    // Old processes, saved paths and Git's worktree metadata still name this directory.
    fs.symlinkSync(path.resolve(current), legacy, 'dir');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return current;
}
