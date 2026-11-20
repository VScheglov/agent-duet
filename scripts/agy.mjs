// Antigravity CLI boundary: invocation, catalog, stream normalization and read-only checks.
// Process lifecycle, queueing, receipts and policy remain shared with the Codex runner.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { duetEnv } from './config.mjs';
import { confirmVerification } from './verification.mjs';

export const AGY_BIN = duetEnv('AGY_BIN') || 'agy';
export const AGY_HOME = duetEnv('AGY_HOME') || path.join(os.homedir(), '.gemini', 'antigravity-cli');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LEVEL_SUFFIX = /-(low|medium|high|xhigh|max)$/i;
const CATALOG_UNAVAILABLE = 'agy models unavailable; model check skipped (check the network or VPN)';
let catalog; // undefined: not fetched; null: unavailable. One fetch per runner invocation.

export function agyDefaults() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(AGY_HOME, 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { model: null, unreadable: true };
    return { model: typeof settings.model === 'string' ? settings.model : null };
  } catch (err) { return { model: null, unreadable: err.code !== 'ENOENT' }; }
}

const AUTH_ERROR = 'agy authentication failed. Use your real HOME, unlock the OS credential manager and sign in to agy from your own terminal before retrying.';
const AUTH_DIAGNOSTIC = /OS credential manager (?:is )?unavailable|(?:auth(?:entication|orization)? (?:timed out|timeout)|timed out waiting for (?:auth|sign-in))/i;
const cliLog = path.join(AGY_HOME, 'cli.log');

function logStat() {
  try { return fs.statSync(cliLog); } catch { return null; }
}

// agy 1.5.10 invokes the platform opener through PATH during OAuth startup.
// Prevent an unattended browser launch, even on the first catalog probe. Restore
// normal tool lookup as soon as agy starts the conversation, or on any exit.
export function agyStartup() {
  const before = logStat();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-agy-'));
  const attempted = path.join(dir, 'attempted');
  const openers = process.platform === 'darwin' ? ['open'] : ['xdg-open', 'termux-open-url'];
  const close = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    process.off('exit', close);
  };
  process.once('exit', close);
  for (const opener of openers) {
    fs.writeFileSync(path.join(dir, opener), '#!/bin/sh\n: > "${0%/*}/attempted"\nexit 1\n', { mode: 0o700 });
  }
  return {
    env: { ...process.env, PATH: dir + path.delimiter + (process.env.PATH ?? '/usr/bin:/bin') },
    close,
    allowTools() {
      // Keep ownership of the private PATH directory until the child exits.
      for (const opener of openers) fs.rmSync(path.join(dir, opener), { force: true });
    },
    authError(stderr) {
      if (fs.existsSync(attempted) || AUTH_DIAGNOSTIC.test(stderr)) return AUTH_ERROR;
      const after = logStat();
      if (!after?.isFile()) return null;
      const appended = before && before.dev === after.dev && before.ino === after.ino && before.size <= after.size;
      const start = Math.max(appended ? before.size : 0, after.size - 65536);
      let fd;
      try {
        fd = fs.openSync(cliLog, 'r');
        const buffer = Buffer.alloc(after.size - start);
        const n = fs.readSync(fd, buffer, 0, buffer.length, start);
        return AUTH_DIAGNOSTIC.test(buffer.toString('utf8', 0, n)) ? AUTH_ERROR : null;
      } catch { return null; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
  };
}

function agyCatalog() {
  if (catalog !== undefined) return catalog;
  const startup = agyStartup();
  let r;
  try {
    r = spawnSync(AGY_BIN, ['models'], { env: startup.env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    if (r.error || r.status !== 0 || !r.stdout?.includes('\t')) {
      const problem = startup.authError(r.stderr);
      if (problem) throw new Error(problem);
    }
  } finally { startup.close(); }
  const models = (r.stdout || '').split(/\r?\n/).flatMap((line) => {
    const match = /^([^\s]+)\t(.+)$/.exec(line.trim());
    if (!match) return [];
    const suffix = LEVEL_SUFFIX.exec(match[1]);
    return [{ slug: match[1], name: match[2], family: suffix ? match[1].slice(0, -suffix[0].length) : null, level: suffix?.[1].toLowerCase() ?? null }];
  });
  catalog = null;
  if (r.error || r.status !== 0 || !models.length) return catalog;
  const families = new Map();
  for (const m of models) {
    if (!m.family) continue;
    const key = m.family.toLowerCase();
    if (!families.has(key)) families.set(key, { slug: m.family, levels: new Map() });
    families.get(key).levels.set(m.level, m.slug);
  }
  return (catalog = { models, families });
}

function catalogModel(available, name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  const exact = available.models.find((m) => m.slug.toLowerCase() === lower || m.name.toLowerCase() === lower);
  if (exact) return exact;
  const family = available.families.get(lower);
  return family ? { slug: family.slug, family: family.slug, level: null } : null;
}

// Keep CLI choices separate from the effective slug and its sources. A settings model
// fixes its default level, but an explicit --effort overrides that level within its family.
export function checkAgyChoice(model, effort, { switchEffort = false } = {}) {
  if (effort && !EFFORTS.includes(effort)) throw new Error(`unknown agy effort: ${effort}; known: ${EFFORTS.join(', ')}`);
  const available = agyCatalog();
  const choice = resolveAgyChoice(model, effort, agyDefaults(), available, switchEffort);
  // Keep the catalog with the session. Subsequent processes can display observed
  // slugs without a network or keychain operation, even after settings change.
  return available ? { ...choice, modelCatalog: available.models } : choice;
}

function resolveAgyChoice(model, effort, defaults, available, switchEffort) {
  const configured = !model;
  let selected = available ? catalogModel(available, model || defaults.model) : null;
  // An effort-only switch replaces a previously selected slug's fixed level. With
  // no catalog, a literal slug's suffix still lets us pass family + effort safely.
  if (switchEffort && model) {
    const suffix = LEVEL_SUFFIX.exec(model);
    if (selected?.level || (!available && suffix)) {
      model = selected?.family ?? model.slice(0, -suffix[0].length);
      selected = available ? catalogModel(available, model) : null;
    }
  }
  // A literal slug's fixed level is known even when the catalog cannot be fetched.
  const suffix = !available && model ? LEVEL_SUFFIX.exec(model) : null;
  const fixed = selected ?? (suffix ? { slug: model, family: model.slice(0, -suffix[0].length), level: suffix[1].toLowerCase() } : null);
  if (!configured && fixed?.level && effort && fixed.level !== effort) {
    throw new Error(`${fixed.slug} already fixes level "${fixed.level}" and conflicts with --effort=${effort}; pass the family instead: --model ${fixed.family} --effort ${effort}`);
  }
  const unchecked = (note) => ({
    model, effort, modelCheckNote: note,
    modelInfo: { model: model || defaults.model, effort, fromConfig: configured && defaults.model ? ['model'] : [] },
  });
  if (!available) return unchecked(CATALOG_UNAVAILABLE);
  if (!selected) {
    if (configured) return unchecked(defaults.unreadable ? 'agy settings.json is unreadable; model check skipped'
      : `agy settings model ${defaults.model ? `"${defaults.model}" is unknown` : 'is missing'}; model check skipped`);
    throw new Error(`unknown agy model: ${model}; available: ${available.models.map((m) => m.slug).join(', ')}; families: ${[...available.families.values()].map((f) => f.slug).join(', ')}`);
  }
  if (!selected.family) {
    return {
      model: configured ? null : selected.slug, effort,
      modelCheckNote: effort ? `agy standalone model ${selected.slug}: effort check skipped (behavior not probed)` : null,
      modelInfo: { model: selected.slug, effort, fromConfig: configured ? ['model'] : [] },
    };
  }
  const family = available.families.get(selected.family.toLowerCase());
  const level = effort ?? selected.level;
  if (level && !family.levels.has(level)) {
    throw new Error(`${family.slug} has no "${level}" effort; available: ${EFFORTS.filter((e) => family.levels.has(e)).join(', ')}`);
  }
  return {
    model: configured ? null : selected.slug, effort, modelCheckNote: null,
    modelInfo: {
      model: level ? family.levels.get(level) : family.slug,
      effort: level,
      family: family.slug,
      fromConfig: configured ? (effort || !selected.level ? ['family'] : ['model', 'effort']) : [],
    },
  };
}

// init usually echoes the requested family. The planner transcript names the slug.
export function observedAgyModel(info, actual, models) {
  if (!info || info.effort || typeof actual !== 'string') return null;
  const suffix = LEVEL_SUFFIX.exec(actual);
  const family = info.family ?? info.model;
  if (!suffix || actual.slice(0, -suffix[0].length).toLowerCase() !== family?.toLowerCase()) return null;
  const selected = models?.find((m) => m.slug.toLowerCase() === actual.toLowerCase());
  return { ...info, family, model: selected?.slug ?? actual, effort: suffix[1].toLowerCase() };
}

export function agyArgs(st, conversation, schema) {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--json-schema', schema, '--disable-slash-commands'];
  if (st.codex.model) args.push('--model', st.codex.model);
  if (st.codex.effort) args.push('--effort', st.codex.effort);
  if (conversation) args.push('--conversation', conversation);
  const outside = (dir) => {
    const rel = path.relative(st.cwd, dir);
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  };
  for (const dir of new Set((st.subject.paths ?? []).map((file) => path.dirname(file)).filter(outside))) args.push('--add-dir', dir);
  const sandbox = st.codex.sandbox ?? 'inherit';
  if (sandbox === 'danger-full-access') args.push('--dangerously-skip-permissions');
  else if (sandbox === 'workspace-write' || sandbox === 'read-only') {
    const settings = { toolPermission: 'proceed-in-sandbox', enableTerminalSandbox: true };
    if (sandbox === 'read-only') settings.permissions = { allow: ['read_file(*)'], deny: ['write_file(*)'] };
    args.push('--sandbox', '--settings', JSON.stringify(settings));
  }
  return [...args, '-p='];
}

export const agyConversation = (id) => typeof id === 'string' && /^[\w-]+$/.test(id)
  ? path.join(AGY_HOME, 'conversations', `${id}.db`) : null;

// Large tool output can have an agy preview wrapper before the ordinary header.
// Everything after "Command output:" belongs to the subprocess.
const PREVIEW = /^The tool's output was truncated due to being too long\. You can find the full output in a file at file:\/\/[^\r\n]+\.\r?\n\r?\nHere is a preview with the middle of the output truncated:\r?\n/;
const EXIT_HEADER = /^(?:Created At: [^\r\n]*\r?\n)?(?:Completed At: [^\r\n]*\r?\n)?Command exited with code (-?\d+)\.(?:\r?\n|$)/;

// Each step may send partial updates; DONE can omit the tool name and parameters.
export class AgyEvents {
  steps = new Map();
  truncated = new Map();
  commandAttempts = [];
  failedMcpCall = null;
  result = null;
  beganWork = false;
  firstInput = null;

  accept(event) {
    if (event.event === 'init' && event.conversation_id) return [{ type: 'thread.started', thread_id: event.conversation_id }];
    if (event.event === 'result') {
      this.result = event.result ?? {};
      return this.result.status === 'SUCCESS'
        ? [{ type: 'turn.completed', usage: this.result.usage ?? null }]
        : [{ type: 'turn.failed', error: { message: this.result.error || 'agy turn failed' } }];
    }
    const update = event.event === 'step_update' ? event.step_update : null;
    if (!update || !Number.isInteger(update.step_index)) return [];
    const index = update.step_index;
    const prev = this.steps.get(index) ?? { text: '', started: false, completed: false };
    const step = { ...prev, ...update, tool_info: { ...prev.tool_info, ...update.tool_info }, text: prev.text + (typeof update.text_delta === 'string' ? update.text_delta : '') };
    this.steps.set(index, step);
    if (step.step_type === 'user_input' && this.firstInput === null) this.firstInput = index;
    if (step.step_type && (step.step_type !== 'user_input' || index !== this.firstInput)) this.beganWork = true;
    const cancelled = ['CANCELLED', 'CANCELED', 'KILLED', 'ABORTED'].includes(step.state);
    const complete = step.state === 'DONE' || step.state === 'ERROR' || cancelled;
    if (prev.completed) return [];
    if (step.step_type === 'agent_response') {
      if (!complete) return [];
      step.completed = true;
      return [{ type: 'item.completed', item: { id: `step_${index}`, type: 'agent_message', text: step.text } }];
    }
    if (step.step_type !== 'tool') return [];
    const info = step.tool_info;
    const parameters = info.parameters ?? {};
    const tool = step.tool_name ?? info.name;
    let item;
    if (tool === 'run_command') {
      const command = parameters.CommandLine ?? '';
      const match = complete && !cancelled && EXIT_HEADER.exec(String(info.output ?? '').replace(PREVIEW, ''));
      const exit = match && !(step.state === 'ERROR' && Number(match[1]) === 0) ? Number(match[1]) : null;
      let status = 'in_progress';
      if (step.state === 'ERROR') status = info.output ? 'failed' : 'declined';
      else if (complete) status = exit === null ? 'incomplete' : exit === 0 ? 'completed' : 'failed';
      item = { id: `step_${index}`, type: 'command_execution', command, exit_code: exit, status };
      if (typeof command === 'string' && command.endsWith('…') && command.length >= 500) {
        this.truncated.set(index, { command, exit });
        item.command_truncated = true;
        item.exit_code = null; // a clipped prefix cannot prove a check's exit
      }
      if (complete) this.commandAttempts.push({ index, command });
      if (complete && typeof info.output === 'string') item.aggregated_output = info.output;
    } else if (tool === 'call_mcp_tool') {
      item = { id: `step_${index}`, type: 'mcp_tool_call', server: parameters.ServerName ?? parameters.server_name ?? parameters.serverName ?? parameters.server ?? '', tool: parameters.ToolName ?? parameters.tool_name ?? parameters.toolName ?? parameters.tool ?? '', status: complete ? (step.state === 'ERROR' ? 'failed' : 'completed') : 'in_progress' };
      // A result's MCP denial is generic. Keep the last failed call before the
      // result, even when subsequent calls succeeded.
      if (step.state === 'ERROR' && !this.result) this.failedMcpCall = { server: item.server, tool: item.tool };
    } else if (tool === 'search_web') {
      item = { id: `step_${index}`, type: 'web_search', query: parameters.query ?? parameters.Query ?? '', status: complete ? (step.state === 'ERROR' ? 'failed' : 'completed') : 'in_progress' };
    } else return [];
    if (!complete && (step.state !== 'ACTIVE' || prev.started)) return [];
    if (complete) step.completed = true;
    else step.started = true;
    return [{ type: complete ? 'item.completed' : 'item.started', item }];
  }

  // Transcript indices span the whole conversation. Bind model observations to
  // this turn's planner steps and commands to their exact slot in a tool batch.
  async reconcile(id, info, models, eventsFile) {
    const observe = info?.model && !info.effort && (info.family || !models);
    if (!observe && !this.truncated.size) return {};
    const logs = agyConversation(id) ? path.join(AGY_HOME, 'brain', id, '.system_generated', 'logs') : null;
    let model = null;
    const read = async (name, full) => {
      if (!logs) return;
      const input = fs.createReadStream(path.join(logs, name), { encoding: 'utf8' });
      try {
        for await (const line of createInterface({ input, crlfDelay: Infinity })) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row?.type !== 'PLANNER_RESPONSE' || !Number.isInteger(row.step_index)) continue;
          if (observe && this.steps.get(row.step_index)?.step_type === 'agent_response') {
            model = observedAgyModel(info, row.model, models) ?? model;
          }
          if (!full || !Array.isArray(row.tool_calls)) continue;
          for (const [k, call] of row.tool_calls.entries()) {
            const clipped = this.truncated.get(row.step_index + 1 + k);
            const cmd = call?.args?.CommandLine;
            if (clipped && call?.name === 'run_command' && typeof cmd === 'string'
              && cmd.length >= clipped.command.length && cmd.startsWith(clipped.command.slice(0, -1))) clipped.full = cmd;
          }
        }
      } catch (err) {
        if (!err.code) throw err;
        // Transcripts are optional. Leave the wire evidence intact when unavailable.
      } finally { input.destroy(); }
    };
    if (this.truncated.size) await read('transcript_full.jsonl', true);
    if (observe && !model) await read('transcript.jsonl', false);
    if (observe && !model && !this.truncated.size) await read('transcript_full.jsonl', false);
    const recovered = new Map([...this.truncated].filter(([, c]) => c.full).map(([i, c]) => [`step_${i}`, c]));
    if (recovered.size) await restoreCommands(eventsFile, recovered);
    // Only the fallback path needs to disambiguate clipped attempts in a receipt.
    const attempts = this.truncated.size > recovered.size ? this.commandAttempts.map(({ index, command }) => {
      const c = this.truncated.get(index);
      return { command: c?.full ?? command, truncated: !!c && !c.full };
    }) : null;
    return { model, attempts };
  }
}

async function restoreCommands(file, recovered) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const event = JSON.parse(line);
      const c = event.item?.command_truncated && recovered.get(event.item.id);
      if (c) {
        event.item.command = c.full;
        event.item.exit_code = event.type === 'item.completed' ? c.exit : null;
        delete event.item.command_truncated;
      }
      fs.writeFileSync(fd, (c ? JSON.stringify(event) : line) + '\n');
    }
    fs.renameSync(tmp, file);
  } finally { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); }
}

// A clipped attempt is evidence of neither success nor failure. Set it aside
// before the common matcher so it cannot borrow or consume an earlier full run.
export async function confirmAgyVerification(reply, file, attempts) {
  const before = new Map();
  const uncertain = new Map();
  for (let n = reply.checks.length - 1; n >= 0; n--) {
    const check = reply.checks[n];
    if (check.outcome === 'skipped') continue;
    const command = check.command.trim();
    const end = before.get(command) ?? attempts.length;
    for (let i = end - 1; i >= 0; i--) {
      const a = attempts[i];
      if (!(a.command === command || (a.truncated && command.startsWith(a.command.slice(0, -1))))) continue;
      before.set(command, i);
      if (a.truncated) {
        uncertain.set(n, {
          ...check, confirmation: 'unconfirmed',
          event: { command: a.command, exit_code: null, status: 'truncated' },
          note: [check.note, 'agy truncated the command and its full text could not be recovered'].filter(Boolean).join(' — '),
        });
      }
      break;
    }
  }
  const checks = reply.checks.filter((_, n) => !uncertain.has(n));
  const receipt = await confirmVerification({ ...reply, checks }, file);
  let next = 0;
  receipt.checks = reply.checks.map((_, n) => uncertain.get(n) ?? receipt.checks[next++]);
  if (uncertain.size && receipt.label === 'executed') receipt.label = 'partial';
  return receipt;
}

// Only the JSON Schema features used by the three shipped round schemas, with no coercion.
function accepts(value, schema) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
      return Object.entries(value).every(([key, child]) => schema.properties?.[key]
        ? accepts(child, schema.properties[key]) : schema.additionalProperties !== false);
    case 'array': return Array.isArray(value) && value.every((child) => accepts(child, schema.items));
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

export function agyAnswer(result, schemaFile) {
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  // The common verificationClaims path handles absent/invalid receipt fields.
  // Validate every other field against the same schema supplied to the CLI.
  const valid = (v) => accepts(schema.properties.checks ? { ...v, checks: [], gaps: [] } : v, schema);
  if (result?.structured_output != null) return valid(result.structured_output) ? result.structured_output : null;
  // agy's prose can precede the final object. A fenced final JSON block is accepted too.
  const text = String(result?.response ?? '').trim().replace(/\s*```\s*$/, '').trim();
  if (!text.endsWith('}')) return null;
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    try {
      const value = JSON.parse(text.slice(i));
      if (valid(value)) return value;
    } catch {}
  }
  return null;
}

export function agyError(stderr) {
  for (const line of stderr.split(/\r?\n/).reverse()) {
    const start = line.indexOf('AGY_ERROR: ');
    if (start < 0) continue;
    try { return JSON.parse(line.slice(start + 11)); } catch {}
  }
  return null;
}

export const AGY_READ_ONLY = 'Read-only is a promise plus a before/after tree check in agy, not an enforced shell sandbox. Read files and run read-only commands only; do not write, add or remove files.';

// Git scopes the list to cwd, includes tracked + untracked, and respects ignores. Outside
// Git, cap traversal at 20,000 entries; lstat never follows symlinks outside the workspace.
export function fingerprint(cwd, ignored = new Set()) {
  const files = new Map();
  const warnings = new Set();
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const inGit = git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';
  const note = (file) => {
    if (ignored.has(file)) return;
    try {
      const full = path.join(cwd, file);
      const stat = fs.lstatSync(full, { bigint: true });
      if (!stat.isDirectory()) files.set(file, `${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.isSymbolicLink() ? fs.readlinkSync(full) : ''}`);
    } catch (err) {
      if (err.code !== 'ENOENT') warnings.add(`cannot fingerprint ${file}: ${err.code}`);
    }
  };
  if (inGit) {
    const r = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.']);
    if (r.error || r.status !== 0) warnings.add('git file listing failed; read-only tree check incomplete');
    else for (const file of new Set(r.stdout.split('\0').filter(Boolean))) note(file);
  } else {
    let entries = 0;
    const walk = (dir) => {
      let list;
      try { list = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
      catch (err) { warnings.add(`cannot list ${dir || '.'}: ${err.code}`); return; }
      for (const entry of list) {
        if (++entries > 20_000) { warnings.add('read-only tree check capped at 20000 entries'); return; }
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else note(file);
        if (entries > 20_000) return;
      }
    };
    walk('');
  }
  return { files, warnings: [...warnings] };
}

export function readOnlyChanges(before, after) {
  return [...new Set([...before.files.keys(), ...after.files.keys()])].sort().flatMap((file) => {
    if (before.files.get(file) === after.files.get(file)) return [];
    return [{ path: file, change: !before.files.has(file) ? 'added' : !after.files.has(file) ? 'removed' : 'changed' }];
  });
}
