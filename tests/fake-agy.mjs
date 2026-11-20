#!/usr/bin/env node
// Boundary fake for the agy 1.5.10 stream and conversation transcripts.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { duetEnv } from '../scripts/config.mjs';

const args = process.argv.slice(2);
const home = duetEnv('AGY_HOME');
function cliLog(line) {
  if (!line) return;
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'cli.log'), line + '\n');
}
function tryLogin() {
  // Used only with a recording fake opener first on the fixture's PATH.
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (!process.env.FAKE_DESKTOP_MARKER) throw new Error('fake login requires the recording opener fixture');
  spawnSync(opener, ['https://accounts.google.invalid/test-login']);
  process.exit(1);
}
if (args[0] === 'models') {
  fs.appendFileSync(`${process.env.FAKE_AGY_STATE}.models`, 'models\n');
  cliLog(process.env.FAKE_AGY_MODELS_LOG);
  if (process.env.FAKE_AGY_MODELS_LOGIN) tryLogin();
  if (process.env.FAKE_AGY_MODELS_STDERR) console.error(process.env.FAKE_AGY_MODELS_STDERR);
  if (process.env.FAKE_AGY_MODELS_FAIL) process.exit(1);
  console.log('Fetching available models...');
  console.log('gemini-3.8-flash-low\tGemini 3.8 Flash (Low)');
  console.log('gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)');
  console.log('gemini-3.8-flash-high\tGemini 3.8 Flash (High)');
  console.log('gemini-4-carbon-high\tGemini 4 Carbon (High)');
  console.log('gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)');
  console.log('gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)');
  console.log('gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)');
  console.log('gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)');
  console.log('gemini-pro-orchestrator\tGemini Pro Orchestrator');
  console.log('gemini-pro-orchestrator-argon\tGemini Pro Orchestrator Argon');
  process.exit(0);
}
const input = fs.readFileSync(0, 'utf8');
const message = JSON.parse(input.trim());
if (message.event !== 'user' || message.message?.role !== 'user') throw new Error('invalid stream input');
const script = JSON.parse(fs.readFileSync(process.env.FAKE_AGY_SCRIPT, 'utf8'));
const statePath = process.env.FAKE_AGY_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { calls: [] };
const step = script[state.calls.length];
const call = { args, input, prompt: message.message.content, cwd: process.cwd(), home: process.env.HOME };
if (step?.probeEnv) call.gitSelectors = step.probeEnv.filter((key) => key in process.env);
state.calls.push(call);
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
if (!step) throw new Error('fake agy: no scripted reply left');
cliLog(step.cliLog);
if (step.login) tryLogin();
if (step.fail) {
  console.error(step.fail);
  process.exit(1);
}
const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : crypto.randomUUID();
const logs = path.join(home, 'conversations');
fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(path.join(logs, `${conversation}.db`), 'fake SQLite conversation');
fs.writeFileSync(path.join(logs, `${conversation}.db-wal`), 'fake write-ahead log');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const requested = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
if (!step.noInit) emit({ event: 'init', conversation_id: conversation, init: { model: requested, cwd: process.cwd(), tools: [], permission_mode: 'always-proceed' } });
const brain = path.join(home, 'brain', conversation, '.system_generated', 'logs');
fs.mkdirSync(brain, { recursive: true });
const transcript = path.join(brain, 'transcript.jsonl');
const previous = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse) : [];
const first = previous.length ? previous.at(-1).step_index + 1 : 0;
const commands = step.commands ?? [];
const planner = { step_index: first + 1, type: 'PLANNER_RESPONSE', model: step.model ?? requested, tool_calls: commands.map((c) => ({ name: 'run_command', args: { CommandLine: c.command } })) };
if (!step.noUserInput) emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: first, state: 'DONE', step_type: 'user_input' } });
if (commands.length || step.reply || step.response) {
  emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: planner.step_index, state: 'DONE', step_type: 'agent_response' } });
  const records = [{ step_index: first, type: 'USER_INPUT' }, planner, ...commands.map((_, i) => ({ step_index: first + 2 + i, type: 'GENERIC' }))];
  const append = (file, rows) => fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  if (!step.noTranscript) append(transcript, records.map((r) => r === planner ? { ...r, tool_calls: [] } : r));
  if (!step.noFullTranscript) append(path.join(brain, 'transcript_full.jsonl'), records);
}
for (const [i, command] of commands.entries()) {
  const chars = [...command.command];
  const info = { name: 'run_command', parameters: { CommandLine: chars.length > 512 ? chars.slice(0, 512).join('') + '…' : command.command } };
  const update = { conversation_id: conversation, step_index: first + 2 + i, step_type: 'tool', tool_name: 'run_command', tool_info: info };
  emit({ event: 'step_update', step_update: { ...update, state: 'ACTIVE' } });
  if (command.completed === false) continue;
  const output = command.noOutput ? undefined : command.rawOutput ?? `Created At: now\nCompleted At: now\nCommand exited with code ${command.exit_code ?? 0}.\n\nCommand output:\n${command.output ?? 'ok'}`;
  emit({ event: 'step_update', step_update: { ...update, state: command.state ?? 'DONE', tool_info: { ...info, output } } });
}
for (const update of step.updates ?? []) emit({ event: 'step_update', step_update: { conversation_id: conversation, ...update } });
for (const [file, text] of Object.entries(step.write ?? {})) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), text);
}
for (const file of step.remove ?? []) fs.rmSync(path.resolve(file), { force: true });
if (step.descendant) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: step.descendant === 'stdout' ? ['ignore', 'inherit', 'inherit'] : 'ignore' });
  child.unref();
  fs.appendFileSync(`${statePath}.pids`, `${child.pid}\n`);
}
if (step.hang) {
  if (step.ignoreTerm) process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  if (step.stderr) process.stderr.write(step.stderr);
  if (!step.noResult) emit({ event: 'result', result: { conversation_id: conversation, status: step.status ?? 'SUCCESS', response: step.response ?? JSON.stringify(step.reply ?? ''), ...(step.reply === undefined ? {} : { structured_output: step.reply }), error: step.error, finished_reason: step.finished_reason, denied_actions: step.denied_actions, usage: { input_tokens: 100, output_tokens: 10 } } });
  process.exitCode = step.exitCode ?? 0;
}
