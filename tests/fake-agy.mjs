#!/usr/bin/env node
// Boundary fake for the measured agy 1.5.7 protocol. Never executes scripted commands.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { duetEnv } from '../scripts/config.mjs';

const args = process.argv.slice(2);
if (args[0] === 'models') {
  fs.appendFileSync(`${process.env.FAKE_AGY_STATE}.models`, 'models\n');
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
if (step.fail) {
  console.error(step.fail);
  process.exit(1);
}
const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : crypto.randomUUID();
const logs = path.join(duetEnv('AGY_HOME'), 'conversations');
fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(path.join(logs, `${conversation}.db`), 'fake SQLite conversation');
fs.writeFileSync(path.join(logs, `${conversation}.db-wal`), 'fake write-ahead log');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
if (!step.noInit) emit({ event: 'init', conversation_id: conversation, init: { model: step.model ?? 'gemini-3.8-flash-high', cwd: process.cwd(), tools: [], permission_mode: 'always-proceed' } });
if (!step.noUserInput) emit({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 0, state: 'DONE', step_type: 'user_input' } });
for (const [i, command] of (step.commands ?? []).entries()) {
  const info = { name: 'run_command', parameters: { CommandLine: command.command } };
  const update = { conversation_id: conversation, step_index: i + 1, step_type: 'tool', tool_name: 'run_command', tool_info: info };
  emit({ event: 'step_update', step_update: { ...update, state: 'ACTIVE' } });
  if (command.completed === false) continue;
  const output = command.noOutput ? undefined : `Created At: now\nCompleted At: now\nCommand exited with code ${command.exit_code ?? 0}.\n\nCommand output:\n${command.output ?? 'ok'}`;
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
