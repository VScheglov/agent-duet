// Exercise the rename through the CLI with disposable state roots and fake engines only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUET = path.join(HERE, '..', 'scripts', 'duet.mjs');
const matching = { status: 'matches', notes: 'Implemented as requested.' };
const spec = "# fix(core)!: preserve old builds\n\n## Owner's request\n> Keep existing sessions working.\n";
const reviewAnswer = { verdict: 'approve', summary: 'checked', issues: [], request_check: { status: 'no-brief', notes: 'No owner brief supplied.' }, checks: [], gaps: [] };

export async function compatibilityTests(test, parent) {
  const root = fs.mkdtempSync(path.join(parent, 'compatibility-'));
  // An owner's defaults must never choose a real engine or real state directory.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENT|CODEX)_DUET_/.test(key)));
  const env = {
    ...cleanEnv, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CODE_SESSION_ID: '',
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    AGENT_DUET_AGY_BIN: path.join(HERE, 'fake-agy.mjs'), AGENT_DUET_AGY_HOME: path.join(root, 'agy-home'),
    FAKE_AGY_SCRIPT: path.join(root, 'script.json'), FAKE_AGY_STATE: path.join(root, 'calls.json'),
    FAKE_CODEX_SCRIPT: path.join(root, 'script.json'), FAKE_CODEX_STATE: path.join(root, 'calls.json'),
    FIXTURE_DECISIONS: '{"1":"done"}',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const fakeEngine = path.join(HERE, 'fake-codex.mjs');
  const script = (steps) => {
    fs.writeFileSync(env.FAKE_CODEX_SCRIPT, JSON.stringify(steps));
    fs.rmSync(env.FAKE_CODEX_STATE, { force: true });
  };
  const run = (args, more, cwd = root, input = '') => {
    const r = spawnSync(process.execPath, [DUET, ...args], { cwd, input, env: { ...env, ...more }, encoding: 'utf8', timeout: 20_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const git = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const idOf = (out) => /(?:agent-duet|codex-duet) (\d{8}-\d{6}-[0-9a-f]{4})/.exec(out)?.[1];
  const listState = (base, id) => {
    fs.mkdirSync(path.join(base, id), { recursive: true });
    fs.writeFileSync(path.join(base, id, 'state.json'), JSON.stringify({ id, kind: 'plan', round: 1, maxRounds: 10, phase: 'done', cwd: root, updatedAt: '2026-11-14' }));
  };

  await test('rename: legacy environment names still work and new names win over every conflicting default', () => {
    for (const useNew of [false, true]) {
      const home = path.join(root, useNew ? 'new-env' : 'legacy-env');
      const values = { HOME: home, ENGINE: 'codex', CODEX_BIN: fakeEngine, POLICY: path.join(HERE, 'fixture-policy.mjs'), MODEL: 'fixture-model', EFFORT: 'high', SANDBOX: 'read-only', TIMEOUT_MIN: '2', TIMEOUT_MS: '20000', KILL_GRACE_MS: '100', MAX_PARALLEL: '1', QUEUE_POLL_MS: '10' };
      const more = Object.fromEntries(Object.entries(values).flatMap(([key, value]) => useNew
        ? [[`CODEX_DUET_${key}`, key === 'HOME' ? path.join(root, 'unused-home') : 'invalid'], [`AGENT_DUET_${key}`, value]]
        : [[`CODEX_DUET_${key}`, value]]));
      script([{ reply: reviewAnswer }]);
      const r = run(['start', '--kind', 'plan', '--subject', '-'], more, root, '# Plan');
      assert.equal(r.code, 0, r.err);
      const st = JSON.parse(fs.readFileSync(path.join(home, idOf(r.out), 'state.json'), 'utf8'));
      assert.deepEqual([st.engine, st.codex.model, st.codex.effort, st.codex.sandbox, st.codex.timeoutMin], ['codex', 'fixture-model', 'high', 'read-only', 2]);
      assert.equal(st.phase, 'done', 'the selected policy ran');
      if (useNew) assert.equal(fs.existsSync(path.join(root, 'unused-home')), false);
    }
  });

  await test('rename: agy binary and settings support both prefixes, with the new values winning', () => {
    for (const useNew of [false, true]) {
      const home = path.join(root, useNew ? 'agy-new' : 'agy-old');
      const agyHome = path.join(home, 'agy-settings');
      fs.mkdirSync(agyHome, { recursive: true });
      fs.writeFileSync(path.join(agyHome, 'settings.json'), '{"model":"gemini-4-carbon-high"}');
      const values = { HOME: home, ENGINE: 'agy', AGY_BIN: path.join(HERE, 'fake-agy.mjs'), AGY_HOME: agyHome };
      const more = Object.fromEntries(Object.entries(values).flatMap(([key, value]) => useNew
        ? [[`CODEX_DUET_${key}`, path.join(root, 'invalid-agy')], [`AGENT_DUET_${key}`, value]]
        : [[`CODEX_DUET_${key}`, value]]));
      // Only this legacy-prefix fixture omits the new defaults. Its legacy binary is the same fake.
      if (!useNew) Object.assign(more, { AGENT_DUET_AGY_HOME: undefined, AGENT_DUET_AGY_BIN: undefined });
      script([{ reply: reviewAnswer }]);
      const r = run(['start', '--kind', 'plan', '--subject', '-'], { ...more, FAKE_AGY_SCRIPT: env.FAKE_CODEX_SCRIPT, FAKE_AGY_STATE: env.FAKE_CODEX_STATE }, root, '# Plan');
      assert.equal(r.code, 0, r.err);
      const st = JSON.parse(fs.readFileSync(path.join(home, idOf(r.out), 'state.json'), 'utf8'));
      assert.equal(st.engine, 'agy');
      assert.equal(st.rounds[0].codexModel.model, 'gemini-4-carbon-high');
      assert.ok(fs.existsSync(path.join(agyHome, 'conversations', `${st.codex.threadId}.db`)));
    }
  });

  await test('rename: empty new settings clear old defaults, while legacy timeout and grace values still apply', () => {
    const more = {
      AGENT_DUET_HOME: path.join(root, 'empty-values'), AGENT_DUET_CODEX_BIN: fakeEngine,
      CODEX_DUET_MODEL: 'invalid model', CODEX_DUET_EFFORT: 'invalid effort',
      AGENT_DUET_MODEL: '', AGENT_DUET_EFFORT: '',
      CODEX_DUET_ENGINE: 'agy', CODEX_DUET_SANDBOX: 'read-only',
      AGENT_DUET_ENGINE: '', AGENT_DUET_SANDBOX: '',
    };
    script([{ reply: reviewAnswer }]);
    const cleared = run(['start', '--kind', 'plan', '--subject', '-'], more, root, '# Plan');
    assert.equal(cleared.code, 0, cleared.err);
    const st = JSON.parse(fs.readFileSync(path.join(more.AGENT_DUET_HOME, idOf(cleared.out), 'state.json'), 'utf8'));
    assert.deepEqual([st.codex.model, st.codex.effort], [null, null]);
    assert.deepEqual([st.engine, st.codex.sandbox], ['codex', 'inherit']);
    for (const useNew of [false, true]) {
      script([{ hang: true, ignoreTerm: true }]);
      const timing = { ...more, AGENT_DUET_HOME: path.join(root, useNew ? 'new-timeout' : 'old-timeout'), CODEX_DUET_TIMEOUT_MS: '250', CODEX_DUET_KILL_GRACE_MS: '100' };
      if (useNew) Object.assign(timing, { CODEX_DUET_TIMEOUT_MS: '20000', CODEX_DUET_KILL_GRACE_MS: '10000', AGENT_DUET_TIMEOUT_MS: '250', AGENT_DUET_KILL_GRACE_MS: '100' });
      const began = Date.now();
      const r = run(['start', '--kind', 'plan', '--subject', '-'], timing, root, '# Plan');
      assert.equal(r.code, 1, r.err);
      assert.match(r.err, /did not finish within 250 ms/);
      assert.ok(Date.now() - began < 4000, 'the chosen timeout and kill grace must stop a stubborn fake promptly');
    }
  });

  await test('rename: the next call repairs a missing compatibility link after the directory move', () => {
    const xdg = path.join(root, 'interrupted');
    const legacy = path.join(xdg, 'codex-duet');
    const current = path.join(xdg, 'agent-duet');
    listState(legacy, 'migrated');
    // A runner that died between rename() and symlink() leaves its marker inside the moved directory.
    fs.writeFileSync(path.join(legacy, '.agent-duet-migrating'), 'interrupted');
    fs.renameSync(legacy, current);
    const listed = run(['list', '--all'], { XDG_STATE_HOME: xdg });
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /migrated/);
    assert.equal(fs.realpathSync(legacy), current);
    assert.equal(fs.existsSync(path.join(current, '.agent-duet-migrating')), false, 'the marker goes once the link exists');
    fs.unlinkSync(legacy);
    const unrelated = path.join(xdg, 'absent-target');
    fs.symlinkSync(unrelated, legacy);
    assert.equal(run(['list', '--all'], { XDG_STATE_HOME: xdg }).code, 0);
    assert.equal(fs.readlinkSync(legacy), unrelated, 'an existing dangling link is also an independent entry');

    // A move made before the marker existed is recognised by sessions that still name the old path.
    const early = path.join(root, 'interrupted-unmarked');
    const earlyLegacy = path.join(early, 'codex-duet');
    const earlyCurrent = path.join(early, 'agent-duet');
    fs.mkdirSync(path.join(earlyLegacy, 'old-build'), { recursive: true });
    const worktree = path.join(earlyLegacy, 'old-build', 'worktree');
    fs.writeFileSync(path.join(earlyLegacy, 'old-build', 'state.json'), JSON.stringify({
      id: 'old-build', kind: 'build', round: 1, maxRounds: 10, phase: 'done', cwd: worktree, updatedAt: '2026-11-13',
      subject: { repo: root, worktree, branch: 'codex-duet/old-build', base: 'HEAD' },
    }));
    fs.renameSync(earlyLegacy, earlyCurrent);
    assert.equal(run(['list', '--all'], { XDG_STATE_HOME: early }).code, 0);
    assert.equal(fs.realpathSync(earlyLegacy), earlyCurrent);
  });

  await test('rename: a fresh installation never creates the old name, and a read-only state home still runs', () => {
    const xdg = path.join(root, 'fresh');
    const legacy = path.join(xdg, 'codex-duet');
    listState(path.join(xdg, 'agent-duet'), 'new-session');
    for (let i = 0; i < 2; i++) {
      const listed = run(['list', '--all'], { XDG_STATE_HOME: xdg });
      assert.equal(listed.code, 0, listed.err);
      assert.match(listed.out, /new-session/);
      assert.equal(fs.existsSync(legacy), false, 'no codex-duet link without an interrupted move');
    }
    // An owner who removed the old link on a moved directory without old paths keeps it removed too.
    // Read-only: the state home cannot take a link, yet read-only commands keep working.
    const locked = path.join(root, 'locked');
    const lockedCurrent = path.join(locked, 'agent-duet');
    listState(lockedCurrent, 'kept');
    fs.writeFileSync(path.join(lockedCurrent, '.agent-duet-migrating'), 'interrupted');
    fs.chmodSync(locked, 0o555);
    try {
      for (const args of [['help'], ['list', '--all']]) {
        const r = run(args, { XDG_STATE_HOME: locked });
        assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
      }
      assert.equal(fs.existsSync(path.join(locked, 'codex-duet')), false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  await test('rename: the default state directory moves once, retaining old build paths and branches through a symlink', () => {
    const xdg = path.join(root, 'move');
    const legacy = path.join(xdg, 'codex-duet');
    const current = path.join(xdg, 'agent-duet');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-q'], repo);
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'base'], repo);
    const before = { AGENT_DUET_HOME: legacy, AGENT_DUET_CODEX_BIN: fakeEngine };
    script([{ reply: { summary: 'implemented', responses: [], questions: [], request_check: matching }, write: { 'added.txt': 'added\n' } }]);
    const started = run(['start', '--kind', 'build', '--subject', '-', '--branch', 'codex-duet/legacy'], before, repo, spec);
    assert.equal(started.code, 0, started.err);
    const id = idOf(started.out);
    const approved = run(['review', '--session', id, '--issues', '-'], before, repo, JSON.stringify({ verdict: 'approve', summary: 'approved', issues: [], request_check: matching }));
    assert.equal(approved.code, 0, approved.err);
    const stateFile = path.join(legacy, id, 'state.json');
    const saved = fs.readFileSync(stateFile, 'utf8');
    const st = JSON.parse(saved);
    script([{ reply: { summary: 'implemented', responses: [], questions: [], request_check: matching }, write: { 'finish.txt': 'added\n' } }]);
    const toFinish = run(['start', '--kind', 'build', '--subject', '-', '--branch', 'codex-duet/finish-legacy'], before, repo, spec);
    assert.equal(toFinish.code, 0, toFinish.err);
    const finishId = idOf(toFinish.out);
    const finishApproved = run(['review', '--session', finishId, '--issues', '-'], before, repo, JSON.stringify({ verdict: 'approve', summary: 'approved', issues: [], request_check: matching }));
    assert.equal(finishApproved.code, 0, finishApproved.err);
    const after = { XDG_STATE_HOME: xdg, AGENT_DUET_CODEX_BIN: fakeEngine };
    const listed = run(['list', '--all'], after);
    assert.equal(listed.code, 0, listed.err);
    assert.ok(listed.out.includes(id), listed.out);
    assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(legacy), current);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), saved, 'internal state and absolute paths are untouched');
    assert.equal(git(['branch', '--show-current'], st.cwd), 'codex-duet/legacy');
    const link = fs.lstatSync(legacy).ino;
    for (const args of [['list', '--all'], ['status', '--session', id], ['verify', '--session', id]]) {
      const r = run(args, after);
      assert.equal(r.code, 0, r.err + r.out);
    }
    for (const command of ['status', 'verify']) {
      const r = run([command], after, st.cwd);
      assert.equal(r.code, 0, r.err + r.out);
    }
    assert.equal(fs.lstatSync(legacy).ino, link, 'subsequent calls leave the compatibility link alone');
    const finished = run(['finish', '--session', finishId], after);
    assert.equal(finished.code, 0, finished.err);
    assert.equal(git(['log', '-1', '--format=%s', 'codex-duet/finish-legacy'], repo), 'fix(core)!: preserve old builds');
    assert.match(git(['log', '-1', '--format=%b', 'codex-duet/finish-legacy'], repo), /Implemented by Codex, reviewed by Claude/);
    const discarded = run(['discard', '--session', id], after);
    assert.equal(discarded.code, 0, discarded.err);
    assert.equal(fs.existsSync(st.subject.worktree), false);
    assert.equal(git(['worktree', 'list', '--porcelain'], repo).includes('/worktree'), false);
    assert.equal(git(['branch', '--list', 'codex-duet/legacy'], repo), '');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).phase, 'discarded');
  });

  await test('rename: both default roots use only the new sessions; explicit homes are never moved', () => {
    const xdg = path.join(root, 'both');
    const legacy = path.join(xdg, 'codex-duet');
    const current = path.join(xdg, 'agent-duet');
    listState(legacy, 'legacy-only');
    listState(current, 'new-only');
    const result = run(['list', '--all'], { XDG_STATE_HOME: xdg });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /new-only/);
    assert.doesNotMatch(result.out, /legacy-only/);
    assert.equal(fs.lstatSync(legacy).isSymbolicLink(), false);
    for (const name of ['AGENT_DUET_HOME', 'CODEX_DUET_HOME']) {
      const base = path.join(root, name);
      const old = path.join(base, 'codex-duet');
      listState(old, 'explicit');
      const r = run(['list', '--all'], { [name]: old, XDG_STATE_HOME: base });
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /explicit/);
      assert.equal(fs.lstatSync(old).isSymbolicLink(), false);
      assert.equal(fs.existsSync(path.join(base, 'agent-duet')), false);
    }
  });

  await test('rename: HOME fallback is isolated and a legacy symlink is never moved', () => {
    const fakeHome = path.join(root, 'fake-home');
    const base = path.join(fakeHome, '.local', 'state');
    const old = path.join(base, 'codex-duet');
    listState(old, 'home-fallback');
    const r = run(['list', '--all'], { HOME: fakeHome, XDG_STATE_HOME: '' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /home-fallback/);
    assert.equal(fs.lstatSync(old).isSymbolicLink(), true);
    const xdg = path.join(root, 'linked');
    fs.mkdirSync(xdg);
    fs.symlinkSync(path.join(base, 'agent-duet'), path.join(xdg, 'codex-duet'));
    const linked = run(['list', '--all'], { XDG_STATE_HOME: xdg });
    assert.equal(linked.code, 0, linked.err);
    assert.doesNotMatch(linked.out, /home-fallback/);
    assert.equal(fs.existsSync(path.join(xdg, 'agent-duet')), false);
  });

  await test('rename: concurrent runners share one migrated directory without losing sessions', async () => {
    const xdg = path.join(root, 'race');
    const legacy = path.join(xdg, 'codex-duet');
    listState(legacy, 'raced');
    const results = await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [DUET, 'list', '--all'], { cwd: root, env: { ...env, XDG_STATE_HOME: xdg } });
      let out = '', err = '';
      child.on('error', reject);
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('close', (code) => resolve({ code, out, err }));
    })));
    for (const r of results) {
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /raced/);
    }
    assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(legacy), path.join(xdg, 'agent-duet'));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-compat-')));
  try {
    await compatibilityTests(async (name, fn) => { await fn(); console.log(`ok - ${name}`); }, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
