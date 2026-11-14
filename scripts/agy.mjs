// Antigravity CLI boundary: invocation, catalog, stream normalization and read-only checks.
// Process lifecycle, queueing, receipts and policy remain shared with the Codex runner.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { duetEnv } from './config.mjs';

export const AGY_BIN = duetEnv('AGY_BIN') || 'agy';
export const AGY_HOME = duetEnv('AGY_HOME') || path.join(os.homedir(), '.gemini', 'antigravity-cli');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LEVEL_SUFFIX = /-(low|medium|high|xhigh|max)$/i;
const CATALOG_UNAVAILABLE = 'agy models unavailable; model check skipped (check the network or VPN)';
let catalog; // undefined: not fetched; null: unavailable. One fetch per runner invocation.

export function agyDefaults() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(AGY_HOME, 'settings.json'), 'utf8'));
    return { model: typeof settings.model === 'string' ? settings.model : null };
  } catch { return { model: null }; }
}

function agyCatalog() {
  if (catalog !== undefined) return catalog;
  const r = spawnSync(AGY_BIN, ['models'], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
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
  const defaults = agyDefaults();
  const available = agyCatalog();
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
    if (configured) return unchecked(`agy settings model ${defaults.model ? `"${defaults.model}" is unknown` : 'is missing'}; model check skipped`);
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

// A family without a level is intentionally left to agy. Only its init event can
// resolve that choice; do not guess a default or invent a slug without a catalog.
export function observedAgyModel(info, actual) {
  if (!catalog || !info?.family || info.effort || info.model !== info.family || typeof actual !== 'string') return null;
  const selected = catalogModel(catalog, actual);
  if (!selected?.level || selected.family !== info.family) return null;
  return { ...info, model: selected.slug, effort: selected.level };
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

// Each step may send partial updates; DONE can omit the tool name and parameters.
export class AgyEvents {
  steps = new Map();
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
    const complete = step.state === 'DONE' || step.state === 'ERROR';
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
      const match = /Command exited with code (-?\d+)\./.exec(String(info.output ?? ''));
      const exit = complete && match ? Number(match[1]) : null;
      item = { id: `step_${index}`, type: 'command_execution', command: parameters.CommandLine ?? '', exit_code: exit, status: complete ? (step.state === 'ERROR' && !info.output ? 'declined' : step.state === 'ERROR' || (exit !== null && exit !== 0) ? 'failed' : 'completed') : 'in_progress' };
      if (complete && typeof info.output === 'string') item.aggregated_output = info.output;
    } else if (tool === 'call_mcp_tool') {
      item = { id: `step_${index}`, type: 'mcp_tool_call', server: parameters.server_name ?? parameters.serverName ?? parameters.server ?? '', tool: parameters.tool_name ?? parameters.toolName ?? parameters.tool ?? '', status: complete ? (step.state === 'ERROR' ? 'failed' : 'completed') : 'in_progress' };
    } else if (tool === 'search_web') {
      item = { id: `step_${index}`, type: 'web_search', query: parameters.query ?? parameters.Query ?? '', status: complete ? (step.state === 'ERROR' ? 'failed' : 'completed') : 'in_progress' };
    } else return [];
    if (!complete && (step.state !== 'ACTIVE' || prev.started)) return [];
    if (complete) step.completed = true;
    else step.started = true;
    return [{ type: complete ? 'item.completed' : 'item.started', item }];
  }
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
  if (result?.structured_output != null) return accepts(result.structured_output, schema) ? result.structured_output : null;
  // agy's prose can precede the final object. A fenced final JSON block is accepted too.
  const text = String(result?.response ?? '').trim().replace(/\s*```\s*$/, '').trim();
  if (!text.endsWith('}')) return null;
  for (let i = text.indexOf('{'); i >= 0; i = text.indexOf('{', i + 1)) {
    try {
      const value = JSON.parse(text.slice(i));
      if (accepts(value, schema)) return value;
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
export function fingerprint(cwd) {
  const files = new Map();
  const warnings = new Set();
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const inGit = git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true';
  const note = (file) => {
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
