#!/usr/bin/env node
// Integration checks use the real runner and a fake only at the external CLI boundary.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUET = path.join(HERE, '..', 'scripts', 'duet.mjs');
const review = (extra = {}) => ({ verdict: 'revise', summary: 'agy reviewed', issues: [{ id: 'C1', status: 'open', severity: 'high', title: 'Check input', body: 'Evidence', location: 'a.js:1', recommendation: 'Guard it', confidence: 0.9, reply: '', path: 'a.js', line: 1, quote: 'export const a = 2;' }], request_check: { status: 'matches', notes: 'checked' }, checks: [], gaps: [], ...extra });
const build = { summary: 'agy implemented', request_check: { status: 'matches', notes: 'checked' }, responses: [], questions: [], checks: [{ command: 'node --test', outcome: 'passed', note: '' }], gaps: [] };
const audit = { summary: 'agy audited', findings: [{ id: 'A1', severity: 'high', title: 'Audit finding', body: 'Evidence', location: 'a.js:1', recommendation: 'Fix it', confidence: 0.8 }], coverage: 'All files', notes: '' };

export async function agyTests(test, parent) {
  const root = path.join(fs.realpathSync(parent), 'agy');
  fs.mkdirSync(root, { recursive: true });
  let serial = 0;
  function setup(steps) {
    const dir = path.join(root, String(++serial));
    const cwd = path.join(dir, 'repo');
    const home = path.join(dir, 'state');
    const agyHome = path.join(dir, 'agy-home');
    const script = path.join(dir, 'script.json');
    const callsFile = path.join(dir, 'calls.json');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(agyHome);
    fs.writeFileSync(path.join(agyHome, 'settings.json'), JSON.stringify({ model: 'Gemini 3.8 Flash (High)' }));
    fs.writeFileSync(script, JSON.stringify(steps));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENT|CODEX)_DUET_/.test(key))), AGENT_DUET_HOME: home, AGENT_DUET_ENGINE: 'codex', AGENT_DUET_AGY_BIN: path.join(HERE, 'fake-agy.mjs'), AGENT_DUET_AGY_HOME: agyHome, FAKE_AGY_SCRIPT: script, FAKE_AGY_STATE: callsFile, FAKE_CODEX_SCRIPT: script, FAKE_CODEX_STATE: callsFile, AGENT_DUET_CODEX_BIN: path.join(HERE, 'fake-codex.mjs'), CODEX_HOME: path.join(dir, 'codex-home'), AGENT_DUET_MODEL: '', AGENT_DUET_EFFORT: '', AGENT_DUET_SANDBOX: 'inherit', AGENT_DUET_TIMEOUT_MIN: '', AGENT_DUET_TIMEOUT_MS: '', AGENT_DUET_KILL_GRACE_MS: '150', AGENT_DUET_POLICY: path.join(HERE, 'fixture-policy.mjs'), FIXTURE_DECISIONS: '{"1":"continue","2":"done"}', CLAUDE_CODE_SESSION_ID: '' };
    const run = (args, input = '', more = {}) => {
      const r = spawnSync(process.execPath, [DUET, ...args], { cwd, env: { ...env, ...more }, input, encoding: 'utf8' });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    git('init', '-q');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@t');
    fs.writeFileSync(path.join(cwd, 'a.js'), 'export const a = 1;\n');
    git('add', 'a.js');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(cwd, 'a.js'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(cwd, 'plan.md'), '# Plan\nRead the inputs.\n');
    const ids = () => fs.existsSync(home) ? fs.readdirSync(home).filter((id) => fs.existsSync(path.join(home, id, 'state.json'))) : [];
    const state = () => JSON.parse(fs.readFileSync(path.join(home, ids()[0], 'state.json'), 'utf8'));
    const calls = () => JSON.parse(fs.readFileSync(callsFile, 'utf8')).calls;
    const modelCalls = () => fs.existsSync(`${callsFile}.models`) ? fs.readFileSync(`${callsFile}.models`, 'utf8').trim().split('\n').length : 0;
    return { cwd, home, agyHome, env, run, state, calls, modelCalls, ids, callsFile, git };
  }
  const start = (kind, extra = []) => ['start', '--engine', 'agy', '--kind', kind, ...(kind === 'plan' || kind === 'file' ? ['--subject', 'plan.md'] : kind === 'audit' || kind === 'build' ? ['--subject', '-'] : []), ...extra];

  await test('agy: finish preserves a conventional subject and credits the implementing engine', () => {
    const x = setup([{ reply: build, write: { 'implemented.txt': 'agy wrote this\n' } }]);
    const r = x.run(start('build'), "# feat: implement with agy\n## Owner's request\n> Implement a file.\n");
    assert.equal(r.code, 0, r.err);
    const st = x.state();
    const approval = x.run(['review', '--session', st.id, '--issues', '-'], JSON.stringify({ verdict: 'approve', summary: 'approved', issues: [], request_check: { status: 'matches', notes: 'checked' } }));
    assert.equal(approval.code, 0, approval.err);
    const f = x.run(['finish', '--session', st.id]);
    assert.equal(f.code, 0, f.err);
    assert.equal(x.git('log', '-1', '--format=%s', st.subject.branch).trim(), 'feat: implement with agy');
    assert.match(x.git('log', '-1', '--format=%b', st.subject.branch), /Implemented by agy, reviewed by Claude in 1 round\(s\)/);
  });

  await test('agy models: measured family/level choices resolve to the slug the CLI runs', () => {
    for (const [options, slug, effort] of [
      [['--model', 'gemini-3.8-flash', '--effort', 'high'], 'gemini-3.8-flash-high', 'high'],
      [['--model', 'gemini-4-hydrogen', '--effort', 'xhigh'], 'gemini-4-hydrogen-xhigh', 'xhigh'],
      [['--model', 'gemini-3.8-flash-low', '--effort', 'low'], 'gemini-3.8-flash-low', 'low'],
      [['--effort', 'low'], 'gemini-3.8-flash-low', 'low'],
      [['--model', 'GeMiNi-3.8-FlAsH-LoW'], 'gemini-3.8-flash-low', 'low'],
      [['--model', 'gEmInI 3.8 fLaSh (LoW)'], 'gemini-3.8-flash-low', 'low'],
      [['--model', 'GEMINI-4-CARBON', '--effort', 'high'], 'gemini-4-carbon-high', 'high'],
    ]) {
      const x = setup([{ reply: review(), model: slug }]);
      const r = x.run(start('plan', options));
      assert.equal(r.code, 0, r.err);
      assert.equal(x.state().rounds[0].codexModel.model, slug);
      assert.equal(x.state().rounds[0].codexModel.effort, effort);
      assert.ok(r.out.includes(`Model: ${slug}`), r.out);
      assert.equal(x.modelCalls(), 1);
    }
    for (const options of [
      ['--model', 'gemini-3.8-flash-low', '--effort', 'high'],
      ['--model', 'gemini-3.8-flash-low', '--effort', 'max'],
      ['--model', 'Gemini 3.8 Flash (Low)', '--effort', 'high'],
    ]) {
      const x = setup([]);
      const r = x.run(start('plan', options));
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /gemini-3\.8-flash-low.*(?:fixes|fixed).*low.*family.*gemini-3\.8-flash/);
      assert.equal(fs.existsSync(x.home), false);
    }
    for (const options of [['--effort', 'max'], ['--model', 'gemini-3.8-flash', '--effort', 'max']]) {
      const x = setup([]);
      const r = x.run(start('plan', options));
      assert.equal(r.code, 2, r.err);
      assert.match(r.err, /gemini-3\.8-flash.*max.*available: low, medium, high/);
      assert.equal(fs.existsSync(x.home), false);
    }
    const unavailable = setup([{ reply: review() }]);
    const conflict = unavailable.run(start('plan', ['--model', 'gemini-3.8-flash-low', '--effort', 'high']), '', { FAKE_AGY_MODELS_FAIL: '1' });
    assert.equal(conflict.code, 2, conflict.err);
    assert.match(conflict.err, /already fixes level.*low.*family/);
    assert.equal(fs.existsSync(unavailable.home), false);
  });

  await test('agy models: config family and explicit level keep separate sources; family-only waits for init', () => {
    for (const configured of ['Gemini 3.8 Flash (High)', 'gemini-3.8-flash-high']) {
      const x = setup([{ reply: review(), model: 'gemini-3.8-flash-low' }]);
      fs.writeFileSync(path.join(x.agyHome, 'settings.json'), JSON.stringify({ model: configured }));
      const r = x.run(start('plan', ['--effort', 'low']));
      assert.equal(r.code, 0, r.err);
      const m = x.state().rounds[0].codexModel;
      assert.equal(m.model, 'gemini-3.8-flash-low');
      assert.equal(m.family, 'gemini-3.8-flash');
      assert.deepEqual(m.fromConfig, ['family']);
      assert.match(r.out, /Model: gemini-3\.8-flash-low · family gemini-3\.8-flash \(config\) · low/);
      assert.equal(x.modelCalls(), 1);
      for (const cmd of ['status', 'report', 'list']) assert.equal(x.run([cmd, '--session', x.state().id]).code, 0);
      assert.equal(x.modelCalls(), 1, 'read-only session commands must not fetch the catalog');
    }
    const x = setup([{ reply: review(), model: 'gemini-4-hydrogen-medium' }]);
    const r = x.run(start('plan', ['--model', 'gemini-4-hydrogen']));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Model: gemini-4-hydrogen-medium/);
    assert.equal(x.state().rounds[0].codexModel.model, 'gemini-4-hydrogen-medium');
    assert.equal(x.calls()[0].args.includes('--effort'), false);
    const args = x.calls()[0].args;
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-4-hydrogen');
  });

  await test('agy models: standalone levels and unresolved defaults are passed through with an honest note', () => {
    for (const model of ['gemini-pro-orchestrator', 'GEMINI-PRO-ORCHESTRATOR-ARGON', 'Gemini Pro Orchestrator Argon']) {
      const slug = model.toLowerCase().includes('argon') ? 'gemini-pro-orchestrator-argon' : 'gemini-pro-orchestrator';
      const x = setup([{ reply: review(), model: slug }]);
      const r = x.run(start('plan', ['--model', model, '--effort', 'max']));
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /standalone.*(?:skipped|not probed)/i);
      assert.equal(x.state().rounds[0].codexModel.model, slug);
      assert.equal(x.state().rounds[0].codexModel.effort, 'max');
    }
    const standalone = setup([{ reply: review(), model: 'gemini-pro-orchestrator' }]);
    assert.equal(standalone.run(start('plan', ['--model', 'gemini-pro-orchestrator'])).code, 0);
    assert.equal(standalone.state().rounds[0].codexModel.effort, null);
    assert.equal(standalone.state().codex.modelCheckNote, null);
    for (const configured of [null, 'not in the catalog']) {
      const x = setup([{ reply: review() }]);
      fs.writeFileSync(path.join(x.agyHome, 'settings.json'), JSON.stringify(configured ? { model: configured } : {}));
      const r = x.run(start('plan', ['--effort', 'max']));
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /model check skipped/i);
      assert.equal(x.state().rounds[0].codexModel.model, configured);
      assert.equal(x.state().rounds[0].codexModel.effort, 'max');
      assert.equal(x.modelCalls(), 1);
    }
    for (const options of [['--effort', 'low'], ['--model', 'gemini-3.8-flash', '--effort', 'low']]) {
      const x = setup([{ reply: review() }]);
      const r = x.run(start('plan', options), '', { FAKE_AGY_MODELS_FAIL: '1' });
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /agy models unavailable.*model check skipped/);
      assert.equal(x.state().rounds[0].codexModel.model, options.includes('--model') ? 'gemini-3.8-flash' : 'Gemini 3.8 Flash (High)');
      assert.equal(x.modelCalls(), 1);
    }
  });

  await test('agy models: reply/review/retry level switches replace a fixed slug level and refuse unsupported ones', () => {
    for (const cmd of ['reply', 'review', 'retry']) {
      const x = setup([cmd === 'retry' ? { noResult: true, exitCode: 1, model: 'gemini-3.8-flash-low' } : { reply: cmd === 'review' ? build : review(), model: 'gemini-3.8-flash-low' }, { reply: cmd === 'review' ? build : review(), model: 'gemini-3.8-flash-high' }]);
      const r = x.run(start(cmd === 'review' ? 'build' : 'plan', ['--model', 'gemini-3.8-flash-low']), "# Implement\n## Owner's request\n> Preserve inputs\n");
      assert.equal(r.code, cmd === 'retry' ? 1 : 0, r.err);
      const s = x.state();
      const file = path.join(x.home, s.id, 'state.json');
      const before = fs.readFileSync(file, 'utf8');
      const args = [cmd, '--session', s.id, ...(cmd === 'reply' ? ['--responses', '-'] : cmd === 'review' ? ['--issues', '-'] : [])];
      const input = JSON.stringify(cmd === 'review' ? review() : { responses: [{ id: 'C1', action: 'fixed', note: 'fixed' }] });
      const rejected = x.run([...args, '--effort', 'max'], input);
      assert.equal(rejected.code, 2, rejected.err);
      assert.match(rejected.err, /available: low, medium, high/);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      const explicitConflict = x.run([...args, '--model', 'gemini-3.8-flash-low', '--effort', 'high'], input);
      assert.equal(explicitConflict.code, 2, explicitConflict.err);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      const switched = x.run([...args, '--effort', 'high'], input);
      assert.equal(switched.code, 0, switched.err);
      assert.equal(x.state().codex.model, 'gemini-3.8-flash');
      assert.equal(x.state().codex.effort, 'high');
      assert.equal(x.state().rounds.at(-1).codexModel.model, 'gemini-3.8-flash-high');
      const call = x.calls()[1].args;
      assert.equal(call[call.indexOf('--model') + 1], 'gemini-3.8-flash');
      assert.equal(call[call.indexOf('--effort') + 1], 'high');
      assert.equal(x.modelCalls(), 4, 'one catalog fetch per start/switch invocation');
      if (cmd === 'review') assert.equal(x.run(['discard', '--session', s.id]).code, 0);
    }
    const x = setup([{ reply: review(), model: 'gemini-3.8-flash-low' }, { reply: review() }]);
    assert.equal(x.run(start('plan', ['--model', 'gemini-3.8-flash-low'])).code, 0);
    const r = x.run(['reply', '--session', x.state().id, '--effort', 'high', '--responses', '-'], JSON.stringify({ responses: [{ id: 'C1', action: 'fixed', note: 'fixed' }] }), { FAKE_AGY_MODELS_FAIL: '1' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /agy models unavailable.*model check skipped/);
    const args = x.calls()[1].args;
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash');
    assert.equal(x.state().rounds.at(-1).codexModel.model, 'gemini-3.8-flash');
    assert.equal(x.modelCalls(), 2);
  });

  await test('agy: all modes share the runner, model display, findings/issues and command receipts', () => {
    for (const kind of ['plan', 'code', 'file', 'build', 'audit']) {
      const reply = kind === 'build' ? build : kind === 'audit' ? audit : review({ checks: build.checks });
      const x = setup([{ reply, commands: [{ command: 'node --test', exit_code: 0 }] }]);
      const r = x.run(start(kind), kind === 'build' ? "# Implement\n## Owner's request\n> Change a file\n" : 'Inspect this directory');
      assert.equal(r.code, 0, r.err);
      const s = x.state();
      assert.equal(s.engine, 'agy');
      assert.match(r.out, /agy/);
      assert.match(r.out, /Model: gemini-3\.8-flash-high \(config\)/);
      assert.match(r.out, kind === 'audit' ? /A1.*Audit finding/ : kind === 'build' ? /agy implemented/ : /C1.*Check input/);
      if (['code', 'build'].includes(kind)) assert.equal(s.rounds[0].verification.label, 'executed');
      const c = x.calls()[0];
      assert.equal(c.home, process.env.HOME);
      assert.equal(c.cwd, kind === 'build' ? s.subject.worktree : x.cwd);
      assert.deepEqual(c.args.slice(0, 6), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--json-schema', path.join(HERE, '..', 'schemas', `${kind === 'build' || kind === 'audit' ? kind : 'review'}.schema.json`)]);
      assert.ok(c.args.includes('--disable-slash-commands'));
      assert.equal(c.args.at(-1), '-p=');
      assert.equal(c.input.trim().split('\n').length, 1);
      assert.deepEqual(JSON.parse(c.input), { event: 'user', message: { role: 'user', content: c.prompt } });
      const events = fs.readFileSync(path.join(x.home, s.id, 'round-1.events.jsonl'), 'utf8');
      assert.match(events, /"type":"item.completed","item":\{"id":"step_1","type":"command_execution"/);
      const command = events.split('\n').filter(Boolean).map(JSON.parse).find((e) => e.type === 'item.completed' && e.item?.type === 'command_execution');
      assert.equal(command.item.exit_code, 0);
      assert.ok(command._at);
      assert.ok(fs.existsSync(path.join(x.home, s.id, 'round-1.agy.jsonl')));
      if (kind === 'build') assert.equal(x.run(['discard', '--session', s.id]).code, 0);
    }
  });

  await test('agy: model/effort validation precedes session creation; unavailable catalog is reported', () => {
    for (const choice of [['--model', 'nope'], ['--effort', 'extreme'], ['--engine', 'nope']]) {
      const x = setup([]);
      const r = x.run(start('plan', choice));
      assert.equal(r.code, 2, r.err);
      assert.equal(fs.existsSync(x.home), false);
      assert.match(r.err, choice[0] === '--model' ? /available:.*gemini-3.8-flash-low.*gemini-4-carbon-high/ : /codex, agy|low, medium, high, xhigh, max/);
    }
    const x = setup([{ reply: review() }]);
    const r = x.run(start('plan', ['--model', 'gemini-3.8-flash', '--effort', 'high']), '', { FAKE_AGY_MODELS_FAIL: '1' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /agy models.*(?:skipped|unavailable)|(?:skipped|unavailable).*agy models/i);
    const a = x.calls()[0].args;
    assert.equal(a[a.indexOf('--model') + 1], 'gemini-3.8-flash');
    assert.equal(a[a.indexOf('--effort') + 1], 'high');
  });

  await test('agy: sandbox mapping, outside directories and session engine immutability', () => {
    for (const sandbox of ['inherit', 'workspace-write', 'danger-full-access', 'read-only']) {
      const x = setup([{ reply: review() }, { reply: review({ verdict: 'approve', issues: [] }) }]);
      const external = path.join(root, `external-${serial}.md`);
      fs.writeFileSync(external, 'outside document');
      const r = x.run(['start', '--kind', 'file', '--subject', external, '--sandbox', sandbox], '', { AGENT_DUET_ENGINE: 'agy' });
      assert.equal(r.code, 0, r.err);
      const a = x.calls()[0].args;
      assert.equal(a[a.indexOf('--add-dir') + 1], root);
      assert.equal(a.includes('--sandbox'), ['read-only', 'workspace-write'].includes(sandbox));
      assert.equal(a.includes('--dangerously-skip-permissions'), sandbox === 'danger-full-access');
      assert.equal(a.includes('--settings'), ['read-only', 'workspace-write'].includes(sandbox));
      if (a.includes('--settings')) {
        const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
        assert.equal(settings.toolPermission, 'proceed-in-sandbox');
        assert.equal(settings.enableTerminalSandbox, true);
        if (sandbox === 'read-only') assert.deepEqual(settings.permissions, { allow: ['read_file(*)'], deny: ['write_file(*)'] });
      }
      const sid = x.state().id;
      for (const cmd of ['reply', 'retry', 'review']) {
        const rr = x.run([cmd, '--session', sid, '--engine', 'codex', ...(cmd === 'reply' ? ['--responses', '-'] : cmd === 'review' ? ['--issues', '-'] : [])], JSON.stringify(cmd === 'review' ? review() : { responses: [] }));
        assert.equal(rr.code, 2);
        assert.match(rr.err, /engine.*agy|agy.*engine/);
      }
      const rr = x.run(['reply', '--session', sid, '--engine', 'agy', '--responses', '-'], JSON.stringify({ changes: 'fixed', responses: [{ id: 'C1', action: 'fixed', note: 'fixed' }] }));
      assert.equal(rr.code, 0, rr.err);
      assert.equal(x.calls()[1].args[x.calls()[1].args.indexOf('--conversation') + 1], x.state().codex.threadId);
    }
  });

  await test('agy: audit and read-only review detect writes, removals and additions without undoing them', () => {
    for (const kind of ['audit', 'plan']) {
      const x = setup([{ reply: kind === 'audit' ? audit : review(), write: { 'a.js': 'changed', 'new.txt': 'new' }, remove: ['plan.md'] }]);
      const r = x.run(start(kind, kind === 'plan' ? ['--sandbox', 'read-only'] : []), 'Inspect');
      assert.equal(r.code, 0, r.err);
      const s = x.state();
      assert.deepEqual(s.rounds[0].readOnlyViolations, [{ path: 'a.js', change: 'changed' }, { path: 'new.txt', change: 'added' }, { path: 'plan.md', change: 'removed' }]);
      assert.equal(s.readOnlyViolations.length, 3);
      for (const output of [r.out, x.run(['status', '--session', s.id]).out, x.run(['report', '--session', s.id]).out]) assert.match(output, /WARNING.*read-only.*a\.js.*new\.txt.*plan\.md/i);
      assert.equal(fs.readFileSync(path.join(x.cwd, 'new.txt'), 'utf8'), 'new');
      assert.match(x.calls()[0].prompt, /read-only/);
      assert.doesNotMatch(x.calls()[0].prompt, /shell sandbox is read-only/i);
    }
  });

  await test('agy: failures explain errors/denials/missing answers and retry resumes each conversation', () => {
    const failures = [
      [{ exitCode: 1, noResult: true }, /agy exited with code 1/],
      [{ exitCode: 2, noResult: true }, /agy exited with code 2/],
      [{ exitCode: 3, noResult: true, stderr: 'I1114 01:07:22.04 noise\nAGY_ERROR: {"short_error":"deadline hit","retryable":false,"reason":"print_timeout"}\n' }, /deadline hit.*retryable.*false/],
      [{ status: 'ERROR', error: 'API unavailable' }, /API unavailable/],
      [{ response: 'No answer' }, /structured.*(?:answer|output)/],
      [{ response: 'Denied', denied_actions: [{ action: 'command', display_name: 'Bash' }] }, /Bash.*headless.*cannot ask.*danger-full-access/],
      [{ reply: review(), finished_reason: 'print_timeout' }, /print_timeout/],
    ];
    for (const [failure, message] of failures) {
      const x = setup([failure, { reply: review() }]);
      const r = x.run(start('plan'));
      assert.equal(r.code, 1, r.err);
      const s = x.state();
      assert.equal(s.phase, 'codex-failed');
      assert.match(s.pending.error, message);
      assert.doesNotMatch(r.err, /I1114/);
      const retry = x.run(['retry', '--session', s.id]);
      assert.equal(retry.code, 0, retry.err);
      assert.ok(x.calls()[1].args.includes('--conversation'));
      assert.match(x.calls()[1].prompt, /interrupted_turn/);
    }
  });

  await test('agy: JSON response fallback is schema checked; joined agent deltas and tool events normalize', () => {
    const reply = review({ checks: [{ command: 'node --test', outcome: 'failed', note: 'failed' }] });
    const text = 'A streamed message';
    const x = setup([{ response: `Some prose\n${JSON.stringify(reply)}`, commands: [{ command: 'node --test', exit_code: 7 }, { command: 'denied', state: 'ERROR', noOutput: true }], updates: [
      { step_index: 8, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'A streamed ' },
      { step_index: 8, step_type: 'agent_response', state: 'DONE', text_delta: 'message' },
      { step_index: 9, step_type: 'tool', state: 'ACTIVE', tool_name: 'call_mcp_tool', tool_info: { parameters: { server_name: 'server', tool_name: 'lookup' } } },
      { step_index: 9, step_type: 'tool', state: 'DONE' },
      { step_index: 10, step_type: 'tool', state: 'DONE', tool_name: 'search_web', tool_info: { parameters: { query: 'a query' } } },
    ] }]);
    const r = x.run(start('code'));
    assert.equal(r.code, 0, r.err);
    const s = x.state();
    assert.equal(s.rounds[0].verification.label, 'executed');
    const events = fs.readFileSync(path.join(x.home, s.id, 'round-1.events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some((e) => e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text === text));
    assert.ok(events.some((e) => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call' && e.item.server === 'server' && e.item.tool === 'lookup'));
    assert.ok(events.some((e) => e.item?.type === 'web_search' && e.item.query === 'a query'));
    assert.ok(events.some((e) => e.item?.command === 'denied' && e.item.status === 'declined' && e.item.exit_code === null));
    const invalid = setup([{ response: '{"verdict":"approve","issues":[]}' }]);
    assert.equal(invalid.run(start('plan')).code, 1);
    assert.equal(invalid.state().phase, 'codex-failed');
  });

  await test('agy: timeout/cancel before real work adds the MCP/VPN hint; fresh retry resets conversation', async () => {
    for (const cancel of [false, true]) {
      const x = setup([{ hang: true }, { reply: review() }]);
      let r;
      if (!cancel) r = x.run(start('plan'), '', { AGENT_DUET_TIMEOUT_MS: '500' });
      else r = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [DUET, ...start('plan')], { cwd: x.cwd, env: x.env });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.stdin.end();
        const until = Date.now() + 5000;
        const timer = setInterval(() => {
          if (fs.existsSync(x.callsFile)) { clearInterval(timer); child.kill('SIGTERM'); }
          else if (Date.now() > until) { clearInterval(timer); child.kill('SIGTERM'); reject(new Error('fake did not start')); }
        }, 25);
        child.on('close', (code) => { clearInterval(timer); resolve({ code, out, err }); });
      });
      assert.equal(r.code, 1, r.err);
      assert.match(x.state().pending.error, /agy mcp list.*network.*VPN/);
      const rr = x.run(['retry', '--session', x.state().id, '--fresh']);
      assert.equal(rr.code, 0, rr.err);
      assert.equal(x.calls()[1].args.includes('--conversation'), false);
    }
  });

  await test('agy: build review, approval, verify and finish share the existing workflow', () => {
    const x = setup([
      { reply: build, write: { 'a.js': 'export const a = 4;\n' }, commands: [{ command: 'node --test' }] },
      { reply: { ...build, responses: [{ id: 'C1', action: 'fixed', note: 'fixed a.js' }] }, write: { 'a.js': 'export const a = 5;\n' }, commands: [{ command: 'node --test' }] },
    ]);
    const r = x.run(start('build'), "# Implement input\n## Owner's request\n> Change a\n");
    assert.equal(r.code, 0, r.err);
    const sid = x.state().id;
    const revise = x.run(['review', '--engine', 'agy', '--session', sid, '--issues', '-'], JSON.stringify(review()));
    assert.equal(revise.code, 0, revise.err);
    assert.equal(x.calls()[1].args[x.calls()[1].args.indexOf('--conversation') + 1], x.state().codex.threadId);
    assert.match(revise.out, /agy on your issues/);
    assert.equal(x.run(['verify', '--session', sid]).code, 1);
    const approve = x.run(['review', '--session', sid, '--issues', '-'], JSON.stringify(review({ verdict: 'approve', issues: [{ ...review().issues[0], status: 'resolved' }] })));
    assert.equal(approve.code, 0, approve.err);
    assert.equal(x.state().phase, 'done');
    assert.equal(x.run(['verify', '--session', sid]).code, 0);
    assert.match(x.run(['list', '--all']).out, /agy/);
    const report = x.run(['report', '--session', sid]);
    assert.match(report.out, /agy conversation/);
    assert.doesNotMatch(report.out, /Codex/);
    const finish = x.run(['finish', '--session', sid]);
    assert.equal(finish.code, 0, finish.err);
    assert.equal(x.state().phase, 'finished');
    assert.match(x.git('show', '-s', '--format=%B', x.state().subject.branch), /Implemented by agy/);
  });

  await test('agy: later-round fresh retry creates and keeps a new conversation', () => {
    const x = setup([{ reply: review() }, { hang: true }, { reply: review() }, { reply: review({ verdict: 'approve', issues: [] }) }]);
    assert.equal(x.run(start('plan', ['--brief', '-']), "## Owner's request\n> Keep every input\n").code, 0);
    const original = x.state().codex.threadId;
    const sid = x.state().id;
    const input = JSON.stringify({ changes: 'fixed', responses: [{ id: 'C1', action: 'fixed', note: 'fixed' }] });
    const interrupted = x.run(['reply', '--session', sid, '--responses', '-'], input, { AGENT_DUET_TIMEOUT_MS: '500' });
    assert.equal(interrupted.code, 1);
    const retry = x.run(['retry', '--session', sid, '--fresh']);
    assert.equal(retry.code, 0, retry.err);
    assert.equal(x.calls()[2].args.includes('--conversation'), false);
    assert.match(x.calls()[2].prompt, /Keep every input/);
    assert.match(x.calls()[2].prompt, /Evidence/);
    const fresh = x.state().codex.threadId;
    assert.notEqual(fresh, original);
    assert.equal(x.run(['reply', '--session', sid, '--responses', '-'], input).code, 0);
    assert.equal(x.calls()[3].args[x.calls()[3].args.indexOf('--conversation') + 1], fresh);
  });

  await test('agy: fresh or deleted-DB build recovery restores the spec and the current review', () => {
    for (const fresh of [true, false]) {
      const x = setup([{ reply: build }, { hang: true }, { reply: build }]);
      assert.equal(x.run(start('build'), "# Implement\n## Owner's request\n> Preserve all rows\n").code, 0);
      const sid = x.state().id;
      assert.equal(x.run(['review', '--session', sid, '--issues', '-'], JSON.stringify(review()), { AGENT_DUET_TIMEOUT_MS: '500' }).code, 1);
      if (!fresh) fs.rmSync(path.join(x.agyHome, 'conversations', `${x.state().pending.threadId}.db`));
      const r = x.run(['retry', '--session', sid, ...(fresh ? ['--fresh'] : [])]);
      assert.equal(r.code, 0, r.err);
      const call = x.calls()[2];
      assert.equal(call.args.includes('--conversation'), false);
      assert.match(call.prompt, /Preserve all rows/);
      assert.match(call.prompt, /<review_issues>\n- C1/);
      assert.ok(call.prompt.includes(x.state().subject.worktree));
      assert.equal(x.run(['discard', '--session', sid]).code, 0);
    }
  });

  await test('agy: read-only detection also covers failed attempts and non-git directories', () => {
    const x = setup([{ response: 'missing JSON', write: { 'new.txt': 'kept' } }, { reply: audit }]);
    fs.rmSync(path.join(x.cwd, '.git'), { recursive: true });
    const r = x.run(start('audit'), 'Inspect');
    assert.equal(r.code, 1);
    const s = x.state();
    assert.deepEqual(s.pending.readOnlyViolations, [{ path: 'new.txt', change: 'added' }]);
    for (const output of [r.err, x.run(['status', '--session', s.id]).out, x.run(['report', '--session', s.id]).out]) assert.match(output, /WARNING.*read-only.*new\.txt/i);
    assert.equal(x.run(['retry', '--session', s.id]).code, 0);
    assert.equal(x.state().readOnlyViolations[0].path, 'new.txt');
  });

  await test('agy: fresh review recovery still checks responses after the entire diff was reverted', () => {
    const x = setup([{ reply: review() }, { hang: true }, { reply: review({ verdict: 'approve', issues: [] }) }]);
    assert.equal(x.run(start('code')).code, 0);
    fs.writeFileSync(path.join(x.cwd, 'a.js'), 'export const a = 1;\n');
    fs.rmSync(path.join(x.cwd, 'plan.md'));
    const sid = x.state().id;
    const r = x.run(['reply', '--session', sid, '--responses', '-'], JSON.stringify({ responses: [{ id: 'C1', action: 'fixed', note: 'reverted everything' }] }), { AGENT_DUET_TIMEOUT_MS: '500' });
    assert.equal(r.code, 1);
    const retry = x.run(['retry', '--session', sid, '--fresh']);
    assert.equal(retry.code, 0, retry.err);
    assert.match(x.calls()[2].prompt, /reverted everything/);
    assert.equal(x.state().phase, 'done');
  });

  await test('agy: no-op read-only turns ignore Git-ignored and non-git node_modules files', () => {
    for (const inGit of [false, true]) {
      const x = setup([{ reply: audit, write: { 'node_modules/a.txt': 'ignored', 'ignored.txt': 'ignored' } }]);
      if (inGit) fs.writeFileSync(path.join(x.cwd, '.gitignore'), 'node_modules/\nignored.txt\n');
      else fs.rmSync(path.join(x.cwd, '.git'), { recursive: true });
      const r = x.run(start('audit'), 'Inspect');
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(x.state().rounds[0].readOnlyViolations, inGit ? [] : [{ path: 'ignored.txt', change: 'added' }]);
    }
  });

  await test('agy: spawn failure is retryable and process cleanup also reaps descendants', () => {
    const x = setup([{ reply: review() }]);
    const failed = x.run(start('plan'), '', { AGENT_DUET_AGY_BIN: path.join(x.cwd, 'no-agy') });
    assert.equal(failed.code, 1);
    assert.match(x.state().pending.error, /cannot run.*no-agy.*ENOENT/);
    assert.equal(x.run(['retry', '--session', x.state().id]).code, 0);
    for (const [hang, descendant] of [[true, 'stdout'], [true, 'quiet'], [false, 'stdout'], [false, 'quiet']]) {
      const y = setup([{ reply: review(), hang, descendant, ignoreTerm: true, commands: [{ command: 'node --test', completed: false }] }]);
      const r = y.run(start('plan'), '', { AGENT_DUET_TIMEOUT_MS: '500' });
      assert.equal(r.code, hang ? 1 : 0, r.err);
      if (hang) assert.doesNotMatch(y.state().pending.error, /MCP servers/);
      const pids = fs.readFileSync(`${y.callsFile}.pids`, 'utf8').trim().split('\n').map(Number);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  });

  await test('compatibility: an old state without engine remains Codex even with agy as the default', () => {
    const x = setup([{ reply: review() }, { reply: review({ verdict: 'approve', issues: [] }) }]);
    const r = x.run(['start', '--kind', 'plan', '--subject', 'plan.md']);
    assert.equal(r.code, 0, r.err);
    const s = x.state();
    delete s.engine;
    fs.writeFileSync(path.join(x.home, s.id, 'state.json'), JSON.stringify(s));
    const refused = x.run(['retry', '--session', s.id, '--engine', 'agy']);
    assert.equal(refused.code, 2);
    assert.match(refused.err, /engine codex/);
    const rr = x.run(['reply', '--session', s.id, '--responses', '-'], JSON.stringify({ responses: [{ id: 'C1', action: 'fixed', note: 'fixed' }] }), { AGENT_DUET_ENGINE: 'agy' });
    assert.equal(rr.code, 0, rr.err);
    assert.match(rr.out, /Codex verdict/);
    assert.deepEqual(x.calls()[1].args.slice(0, 3), ['exec', 'resume', s.codex.threadId]);
  });

  await test('agy: Codex and agy turns use the same queue slots', async () => {
    const x = setup([{ hang: true }]);
    const y = setup([{ reply: review() }]);
    const shared = { AGENT_DUET_HOME: x.home, AGENT_DUET_MAX_PARALLEL: '1', AGENT_DUET_QUEUE_POLL_MS: '25' };
    const launch = (fixture, args, extra) => {
      const child = spawn(process.execPath, [DUET, ...args], { cwd: fixture.cwd, env: { ...fixture.env, ...shared, ...extra } });
      let err = '';
      child.stderr.on('data', (data) => { err += data; });
      child.stdout.resume();
      child.stdin.end();
      const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, err })));
      return { child, done };
    };
    const wait = async (condition) => {
      const until = Date.now() + 5000;
      while (!condition()) {
        assert.ok(Date.now() < until, 'queue condition timed out');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const a = launch(x, start('plan'), {});
    let b;
    try {
      await wait(() => fs.existsSync(x.callsFile));
      b = launch(y, ['start', '--engine', 'codex', '--kind', 'plan', '--subject', 'plan.md'], {});
      await wait(() => x.ids().some((id) => JSON.parse(fs.readFileSync(path.join(x.home, id, 'state.json'), 'utf8')).phase === 'queued'));
      assert.equal(fs.existsSync(y.callsFile), false);
      a.child.kill('SIGTERM');
      assert.equal((await a.done).code, 1);
      const result = await b.done;
      assert.equal(result.code, 0, result.err);
      assert.equal(y.calls().length, 1);
    } finally {
      a.child.kill('SIGTERM');
      b?.child.kill('SIGTERM');
      await a.done;
      if (b) await b.done;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-agy-'));
  try {
    await agyTests(async (name, fn) => { await fn(); console.log(`ok - ${name}`); }, tmp);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
