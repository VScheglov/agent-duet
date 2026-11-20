#!/usr/bin/env node
// Self-test for the mod (hooks/register.tsx) on a stand-in engine: node tests/mod.mjs
// The sessions it reads are real ones, made by scripts/duet.mjs against the fake Codex.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BELOW, boot, compile, lines, nodes } from './mod-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUET = path.join(HERE, '..', 'scripts', 'duet.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-duet-mod-')));
const repo = path.join(tmp, 'repo');
const elsewhere = path.join(tmp, 'elsewhere');
const insideSpace = path.join(repo, 'in with space');
const outsideSpace = path.join(tmp, 'elsewhere with space');
const home = path.join(tmp, 'state');
const scriptFile = path.join(tmp, 'codex-script.json');
const fakeState = path.join(tmp, 'codex-calls.json');
const decisions = JSON.stringify({ 1: 'continue', 2: 'escalate', 3: 'done' });

const baseEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENT|CODEX)_DUET_/.test(key))),
  AGENT_DUET_ENGINE: 'codex',
  AGENT_DUET_HOME: home,
  AGENT_DUET_CODEX_BIN: path.join(HERE, 'fake-codex.mjs'),
  AGENT_DUET_POLICY: path.join(HERE, 'fixture-policy.mjs'),
  FAKE_CODEX_SCRIPT: scriptFile,
  FAKE_CODEX_STATE: fakeState,
  FIXTURE_DECISIONS: decisions,
  CODEX_HOME: path.join(tmp, 'no-codex-home'), // no model catalog, none of the owner's defaults
  AGENT_DUET_MODEL: '',
  AGENT_DUET_EFFORT: '',
  CLAUDE_CODE_SESSION_ID: 'claude-me', // the session the stand-in engine is, unless a call says otherwise
};

const issue = (id, status, severity = 'high', extra = {}) => ({
  id, status, severity, title: `Issue ${id}`, body: `Body of ${id}`, location: 'a.js:1',
  recommendation: `Fix ${id}`, confidence: 0.8, reply: '', ...extra,
});
const turn = (verdict, issues) => ({ reply: { verdict, summary: `summary: ${verdict}`, issues } });
const responses = (list) => JSON.stringify({ changes: 'x', responses: list });

function scriptCodex(steps) {
  fs.writeFileSync(scriptFile, JSON.stringify(steps));
  fs.rmSync(fakeState, { force: true });
}
function duet(args, input = '', env = {}) {
  const r = spawnSync(process.execPath, [DUET, ...args], { cwd: repo, input, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function git(args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
const sessionId = (out) => /agent-duet (\d{8}-\d{6}-[0-9a-f]{4})/.exec(out)?.[1];
const stateFile = (sid) => path.join(home, sid, 'state.json');
const rewrite = (sid, change) => {
  const st = JSON.parse(fs.readFileSync(stateFile(sid), 'utf8'));
  fs.writeFileSync(stateFile(sid), JSON.stringify({ ...st, ...change(st), updatedAt: new Date().toISOString() }));
};
const footer = async (E, options) => lines(await E.render('SessionMode', options));
const RUNNER = `node "${DUET}"`;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

fs.mkdirSync(repo);
fs.mkdirSync(elsewhere);
fs.mkdirSync(path.join(repo, 'sub'));
fs.mkdirSync(insideSpace);
fs.mkdirSync(outsideSpace);
git(['init', '-q']);
fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
git(['add', 'a.js']);
git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a']);

async function waitFor(check, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const compiled = compile(path.join(HERE, '..', 'hooks', 'register.tsx'), tmp);
// installed from a marketplace, the plugin lives in a folder of the engine's choosing, not in ~/.claude/skills
const installed = path.join(tmp, 'plugins', 'cache', 'agent-duet', 'agent-duet', '0.10.0');
const E = await boot(compiled, { options: { language: 'ru' }, env: { HOME: os.homedir(), AGENT_DUET_HOME: home, CODEX_HOME: baseEnv.CODEX_HOME }, cwd: repo, root: installed });
// The Claude app's sounds, as register.tsx names them; the stub says they exist whatever this machine has.
const APP_SFX = '/Applications/Claude.app/Contents/Resources/ion-dist/audio/voice/sfx';
const APP_SOUNDS = ['tool_approval_needed.mp3', 'enter_voice_mode.mp3', 'disconnected.mp3'];
const SYNTH_SOUNDS = ['sounds/decision.wav', 'sounds/done.wav', 'sounds/error.wav'];
const setAppSounds = (isThere) => APP_SOUNDS.forEach((name) => E.setFile(`${APP_SFX}/${name}`, isThere));
setAppSounds(true);
let id;

await test('rename: legacy language settings survive, with explicit new language and auto taking precedence', async () => {
  for (const [options, pluginConfigs, expected] of [
    [{ language: 'auto' }, { 'codex-duet@skills-dir': { options: { language: 'ru' } } }, /Сессий agent-duet не найдено/],
    [{ language: 'auto' }, { 'codex-duet@codex-duet': { options: { language: 'zh' } } }, /未找到 agent-duet 会话/],
    [{ language: 'en' }, { 'codex-duet@skills-dir': { options: { language: 'ru' } } }, /No agent-duet sessions found/],
    [{ language: 'auto' }, { 'agent-duet@skills-dir': { options: { language: 'auto' } }, 'codex-duet@skills-dir': { options: { language: 'ru' } } }, /No agent-duet sessions found/],
  ]) {
    const m = await boot(compiled, {
      env: { HOME: os.homedir(), AGENT_DUET_HOME: path.join(tmp, 'language-rename'), LC_ALL: 'en_US.UTF-8' },
      cwd: repo, options, settings: { pluginConfigs },
    });
    assert.match(lines(await m.render('Pane')).join('\n'), expected);
  }
});

await test('rename: mod prefers the new home, falls back without moving, and follows the migrated link', async () => {
  const xdg = path.join(tmp, 'mod-roots');
  const legacy = path.join(xdg, 'codex-duet');
  const current = path.join(xdg, 'agent-duet');
  fs.mkdirSync(legacy, { recursive: true });
  const old = await boot(compiled, { env: { HOME: os.homedir(), XDG_STATE_HOME: xdg }, cwd: repo });
  assert.equal(old.atoms.get('agent-duet:diag').root, legacy);
  assert.equal(fs.lstatSync(legacy).isSymbolicLink(), false, 'the mod must not migrate');
  fs.renameSync(legacy, current);
  fs.symlinkSync(current, legacy);
  await old.tick();
  assert.equal(old.atoms.get('agent-duet:diag').root, current, 'an already loaded mod picks up migration');
  assert.ok(fs.existsSync(path.join(current, '.ui-trace.json')));
  fs.unlinkSync(legacy);
  fs.mkdirSync(legacy);
  const both = await boot(compiled, { env: { HOME: os.homedir(), XDG_STATE_HOME: xdg }, cwd: repo });
  assert.equal(both.atoms.get('agent-duet:diag').root, current);
  assert.equal(fs.existsSync(path.join(legacy, '.ui-trace.json')), false);
  for (const env of [
    { CODEX_DUET_HOME: legacy },
    { CODEX_DUET_HOME: legacy, AGENT_DUET_HOME: current },
  ]) {
    const m = await boot(compiled, { env: { HOME: os.homedir(), ...env }, cwd: repo });
    assert.equal(m.atoms.get('agent-duet:diag').root, env.AGENT_DUET_HOME ?? legacy);
  }
});

await test('rename: live atom preferences and choices carry over once, with new settings taking precedence', async () => {
  const prefs = { band: false, sound: false, toasts: true, score: false };
  const choices = { 'session:C1': 'claude' };
  const initialState = new Map([
    ['codex-duet:prefs', prefs], ['codex-duet:focus', 'session'],
    ['codex-duet:choices', choices], ['codex-duet:expanded', { settings: true }],
  ]);
  const env = { HOME: os.homedir(), AGENT_DUET_HOME: path.join(tmp, 'prefs-root'), CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(tmp, 'empty-cache') };
  const first = await boot(compiled, { env, cwd: repo, initialState });
  assert.deepEqual(first.atoms.get('agent-duet:prefs'), prefs);
  assert.deepEqual(first.stored.get('prefs'), prefs, 'the imported prefs survive the next session');
  assert.deepEqual(first.atoms.get('agent-duet:choices'), choices);
  assert.equal(first.atoms.get('agent-duet:focus'), 'session');
  assert.deepEqual(first.atoms.get('agent-duet:expanded'), { settings: true });
  await first.command('duet', 'sound on');
  const second = await boot(compiled, { env, cwd: repo, initialState, store: first.stored });
  assert.equal(second.atoms.get('agent-duet:prefs').sound, true, 'a reload must not import old prefs again');
  const newPrefs = { band: true, sound: true, toasts: false, score: true };
  const explicit = await boot(compiled, { env, cwd: repo, initialState, store: new Map([['prefs', newPrefs]]) });
  assert.deepEqual(explicit.atoms.get('agent-duet:prefs'), newPrefs);
});

await test('rename: persisted legacy preferences also carry over in a new Claude session', async () => {
  const cache = path.join(tmp, 'legacy-store-cache');
  fs.mkdirSync(path.join(cache, 'store'), { recursive: true });
  const prefs = { band: false, sound: false, score: false, toasts: false };
  const oldStore = path.join(cache, 'store', 'codex-duet_skills-dir-012345abcdef.json');
  fs.writeFileSync(oldStore, JSON.stringify({ prefs }));
  const env = { HOME: os.homedir(), AGENT_DUET_HOME: path.join(tmp, 'persisted-root'), CLAUDE_CODE_PLUGIN_CACHE_DIR: cache };
  const first = await boot(compiled, { env, cwd: repo });
  assert.deepEqual(first.atoms.get('agent-duet:prefs'), prefs);
  assert.deepEqual(first.stored.get('prefs'), prefs);
  const second = await boot(compiled, { env, cwd: repo, store: first.stored });
  assert.deepEqual(second.atoms.get('agent-duet:prefs'), prefs);
  assert.deepEqual(JSON.parse(fs.readFileSync(oldStore, 'utf8')), { prefs }, 'legacy storage is read-only');
});

await test('no session: nothing above the prompt or in the footer, the pane says where it looks', async () => {
  assert.equal(await E.render('AbovePrompt'), BELOW);
  assert.equal(await E.render('SessionMode'), BELOW);
  const pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Сессий agent-duet не найдено.'), pane.join('\n'));
  assert.ok(pane.includes('[Звук: вкл]'));
  assert.ok(pane.includes('[▶ Звуки]'));
});

await test("round 1 ends: toast and suggestion, no sound; band and footer show Claude's turn over other mods' rows", async () => {
  scriptCodex([
    turn('revise', [issue('C1', 'open'), issue('C2', 'open', 'medium')]),
    turn('revise', [issue('C1', 'open', 'high', { reply: 'Still reachable' }), issue('C2', 'resolved', 'medium')]),
    turn('approve', [issue('C1', 'open', 'high', { reply: 'I still disagree' })]),
  ]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  const r = duet(['start', '--kind', 'code']);
  assert.equal(r.code, 0, r.err);
  id = sessionId(r.out);
  await E.tick();
  assert.deepEqual(E.sounds, []);
  assert.ok(E.toasts.some((t) => /раунд 1: открыто 2, из них critical\/high: 1/.test(t)), E.toasts.join('\n'));
  assert.deepEqual(E.suggested, ['продолжай agent-duet']);
  const band = await E.render('AbovePrompt');
  assert.match(lines(band)[0], /ход Claude: 2 замечания/);
  assert.equal(band.children.at(-1), BELOW);
  assert.deepEqual(await footer(E), ['[Duet r1 ✍️]']);
  assert.deepEqual(await footer(E, { surface: 'terminal' }), ['Duet r1 ✍️'], 'no clicks outside fullscreen: plain text');
  assert.equal((await E.render('SessionMode')).children.at(-1), BELOW);
});

await test('commit guard: no commit, push or stash in the reviewed repository; everything else passes', async () => {
  assert.match((await E.bash('git commit -m x')).deny ?? '', /идёт ревью/);
  assert.match((await E.bash('cd sub && git push')).deny ?? '', /идёт ревью/);
  assert.equal((await E.bash('git status')).result, 'core reached');
  assert.equal((await E.bash(`git -C ${elsewhere} commit -m x`)).result, 'core reached');
});

// Every row goes through tool.call, without ever executing the supplied command on the host.
const writeActions = ['commit -m x', 'push', 'stash'];
const writeForms = [
  (action) => `git ${action}`,
  (action) => `git -C "${insideSpace}" ${action}`,
  (action) => `git -C '${repo}' ${action}`,
  (action) => `git -C sub -C .. ${action}`,
  (action) => `git -c user.name=x ${action}`,
  (action) => `git --no-pager -C ${repo} ${action}`,
  (action) => `git --work-tree="${insideSpace}" ${action}`,
  (action) => `GIT_DIR=${repo}/.git git ${action}`,
  (action) => `cd "${insideSpace}" && git ${action}`,
  (action) => `cd sub && git ${action}`,
  (action) => `ls; git ${action}`,
  (action) => `false || git ${action}`,
  (action) => `ls\ngit ${action}`,
  (action) => `(git ${action})`,
  (action) => `{ git ${action}; }`,
  (action) => `if git ${action}; then :; fi`,
  (action) => `out="$(git ${action})"`,
  (action) => `echo \`git ${action}\``,
  (action) => `bash -lc 'git ${action}'`,
  (action) => `eval 'git ${action}'`,
  (action) => `bash <<'EOF'\ngit ${action}\nEOF`,
  (action) => `FOO=1 git ${action}`,
  (action) => `env FOO=1 git ${action}`,
  (action) => `sudo -u bob git ${action}`,
  (action) => `nohup git ${action} &`,
  (action) => `command git ${action}`,
  (action) => `timeout 60 git ${action}`,
  (action) => `\\git ${action}`,
  (action) => `/usr/bin/git ${action}`,
  (action) => `git -C "$REPO" ${action}`,
  (action) => `cd "$(mktemp -d)" && git ${action}`,
];
for (const action of writeActions) {
  for (const form of writeForms) {
    const command = form(action);
    await test(`commit guard denies: ${JSON.stringify(command)}`, async () => {
      const result = await E.bash(command);
      assert.match(result.deny ?? '', /идёт ревью/, command);
      assert.ok(result.deny.includes(id), 'the denial names the guarded session');
      assert.equal(result.result, undefined, 'a denied call never reaches the core');
    });
  }
}

const allowedCommands = [
  "rg 'git commit' docs", 'grep -rn "git push" .', 'echo git commit', 'echo "it\'s git stash"',
  "FOO='git commit' ls", 'ls # git commit', '# git push\nls',
  "cat <<'EOF' > notes.md\ngit commit -m x\nEOF",
  'git status', 'git log --grep commit', 'git diff -- commit.txt', 'git show HEAD:push.md',
  'git stash list', 'git stash show', 'git config alias.ci commit',
  ...writeActions.flatMap((action) => [
    `git -C "${outsideSpace}" ${action}`,
    `git -C ${elsewhere} ${action}`,
    `cd "${outsideSpace}" && git ${action}`,
    `(cd ${elsewhere} && git ${action})`,
  ]),
];
for (const command of allowedCommands) {
  await test(`commit guard allows: ${JSON.stringify(command)}`, async () => {
    assert.equal((await E.bash(command)).result, 'core reached', command);
  });
}
for (const action of ['stash push -m wip', 'stash pop']) {
  await test(`commit guard denies: git ${action}`, async () => {
    assert.match((await E.bash(`git ${action}`)).deny ?? '', /идёт ревью/);
  });
}

for (const [name, prefix] of [
  ['assignments', '; x=1'.repeat(12_000)],
  ['newlines', '\n'.repeat(60_000)],
  ['arguments', '-a '.repeat(20_000)],
]) {
  await test(`commit guard: 60 KB of ${name} is decided in under a second`, async () => {
    assert.equal(prefix.length, 60_000, 'the performance input is a full 60 KB');
    for (const [command, denied] of [[prefix, false], [`${prefix}; git push`, true]]) {
      const start = performance.now();
      const result = await E.bash(command);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 1000, `${name}: ${elapsed.toFixed(1)} ms`);
      assert.equal(Boolean(result.deny), denied);
      console.log(`  ${name}${denied ? ' with write' : ''}: ${elapsed.toFixed(1)} ms`);
    }
  });
}

const deepForms = [
  ['substitutions', (program) => '$('.repeat(20_000) + program + ')'.repeat(20_000)],
  ['subshells', (program) => '('.repeat(50_000) + program + ')'.repeat(50_000)],
];
for (const [name, form] of deepForms) {
  await test(`commit guard: deeply nested ${name} with git are denied without throwing`, async () => {
    const result = await E.bash(form('git commit'));
    assert.match(result.deny ?? '', /идёт ревью/);
    assert.ok(result.deny.includes(id), 'the fallback names the first guarded session');
    assert.equal(result.result, undefined);
  });
  await test(`commit guard: deeply nested ${name} without the word git reach core`, async () => {
    for (const program of ['pwd', 'echo legitimate']) {
      assert.equal((await E.bash(form(program))).result, 'core reached');
    }
  });
}

await test('commit guard: every write passes when no session is guarded', async () => {
  const emptyHome = path.join(tmp, 'unguarded');
  fs.mkdirSync(emptyHome);
  const unguarded = await boot(compiled, {
    cwd: repo, env: { HOME: os.homedir(), AGENT_DUET_HOME: emptyHome },
  });
  await unguarded.tick();
  for (const action of writeActions) {
    for (const form of writeForms) {
      assert.equal((await unguarded.bash(form(action))).result, 'core reached', form(action));
    }
  }
  for (const [, form] of deepForms) {
    for (const program of ['git commit', 'pwd', 'echo legitimate']) {
      assert.equal((await unguarded.bash(form(program))).result, 'core reached');
    }
  }
});

const parserDir = path.join(tmp, 'shell-unit');
fs.mkdirSync(parserDir);
const { gitWrites } = await import(pathToFileURL(compile(path.join(HERE, '..', 'hooks', 'shell.ts'), parserDir)).href);
const parserCases = [
  ['git -C a -C "../b c" push', [['push', '/review/b c']]],
  ['git -C ~/project commit', [['commit', '/home/me/project']]],
  ["git -C '~/project' push", [['push', '/review/~/project']]],
  ['git -C \\~/project push', [['push', '/review/~/project']]],
  ['git -C ~"/project" push', [['push', '/review/~/project']]],
  ['git --work-tree=~/project push', [['push', '/review/~/project']]],
  ['git -C ~/"a b" push', [['push', '/home/me/a b']]],
  ["GIT_WORK_TREE='~/project' git push", [['push', '/review/~/project']]],
  ['GIT_WORK_TREE=~/project git push', [['push', '/home/me/project']]],
  ['git -C ~someone/project push', [['push', null]]],
  ['git -C ../review-other push', [['push', '/review-other']]],
  ['git --git-dir=/review/.git push', [['push', '/review']]],
  ['git --git-dir /review/admin push', [['push', '/review/admin']]],
  ['git -C sub --git-dir ../.git push', [['push', '/review']]],
  ['git --work-tree "a b" --git-dir /other/.git commit', [['commit', '/review/a b']]],
  ['git --work-tree sub -C /elsewhere push', [['push', '/elsewhere/sub']]],
  ['GIT_WORK_TREE="a b" GIT_DIR=/other/.git git push', [['push', '/review/a b']]],
  ['GIT_DIR=/other/.git git --work-tree . push', [['push', '/review']]],
  ['GIT_WORK_TREE=/elsewhere git --work-tree /review push', [['push', '/review']]],
  ['git --namespace ns --exec-path=/tools -P --bare --no-replace-objects --literal-pathspecs push', [['push', '/review']]],
  ['git --namespace=ns --exec-path --paginate -p --no-optional-locks -c x=y push', [['push', '/review']]],
  ['git -c alias.x=commit x', []],
  ['cd "a b"; git commit; cd ../sub && git push', [['commit', '/review/a b'], ['push', '/review/sub']]],
  ['pushd sub; git push; popd; git commit', [['push', '/review/sub'], ['commit', '/review']]],
  ['pushd /elsewhere; pushd; git push', [['push', '/review']]],
  ['pushd -n /elsewhere; git push; popd; git commit', [['push', '/review'], ['commit', '/elsewhere']]],
  ['(cd /elsewhere && git push); git commit', [['push', '/elsewhere'], ['commit', '/review']]],
  ['{ cd sub; }; git push', [['push', '/review/sub']]],
  ['out="$(cd /elsewhere && git push)"; git commit', [['push', '/elsewhere'], ['commit', '/review']]],
  ['bash -c "cd /elsewhere; git push"; git commit', [['push', '/elsewhere'], ['commit', '/review']]],
  ['eval \'cd sub\'; git push', [['push', '/review/sub']]],
  ['GIT_WORK_TREE=/elsewhere eval "git push"', [['push', '/elsewhere']]],
  ['GIT_WORK_TREE=/elsewhere eval "git push"; git commit', [['push', '/elsewhere'], ['commit', '/review']]],
  ['cd /elsewhere || git push', [['push', '/review']]],
  ['cd /elsewhere || :; git push', [['push', null]]],
  ['cd /review || :; git push', [['push', '/review']]],
  ['eval "GIT_WORK_TREE=/elsewhere"; git push', [['push', '/elsewhere']]],
  ['cd "$DIR"; git commit; git -C /known push', [['commit', null], ['push', '/known']]],
  ['git -C "a*" push; git --work-tree "$DIR" commit; GIT_DIR="`pwd`" git stash', [['push', null], ['commit', null], ['stash', null]]],
  ['echo git#commit; echo "$(git push)"; echo \'$(git commit)\'', [['push', '/review']]],
  ['echo { git push }', []],
  ["'FOO=1' git push; F'OO'=1 git commit", []],
  ["FOO='git push' git commit", [['commit', '/review']]],
  ["env 'GIT_WORK_TREE=/elsewhere' git push", [['push', '/elsewhere']]],
  ['command FOO=1 git push', []],
  ['FOO=1 command git push; time FOO=1 git commit', [['push', '/review'], ['commit', '/review']]],
  ['echo } git push', []],
  ['echo ${x:-\'$(git push)\'}', []],
  ['echo "${x:-"a; git push "}"', []],
  ['echo "${x:-\'$(git push)\'}"', [['push', '/review']]],
  ['echo "\\$(git push)"', []],
  ['echo \'git push\'; echo $\'git commit\\\' mention\'; git status', []],
  ['echo $\'a\\\'b\'; git push', [['push', '/review']]],
  ['git push 2>/tmp/output; >out git commit', [['push', '/review'], ['commit', '/review']]],
  ['echo x >"$(git push)"', [['push', '/review']]],
  ['cat <<EOF && git push\ngit commit\nEOF', [['push', '/review']]],
  ['cat <<EOF\n$(git push)\nEOF', [['push', '/review']]],
  ["cat <<'EOF'\n$(git push)\nEOF", []],
  ['bash <<EOF\ncd /elsewhere\n$(git push)\nEOF', [['push', '/review']]],
  ['bash <<EOF\ncd /elsewhere\n\\$(git push)\nEOF', [['push', '/elsewhere']]],
  ['cat <<-EOF\n\tgit push\n\tEOF\ngit commit', [['commit', '/review']]],
  ['bash <<-"EOF"\n\tcd sub; git push\n\tEOF', [['push', '/review/sub']]],
  ['cat <<FIRST; bash <<SECOND\ngit commit\nFIRST\ngit push\nSECOND', [['push', '/review']]],
  ['bash <<EOF | cat\ngit push\nEOF', [['push', '/review']]],
  ["cat <<'EOF' | bash\ngit push\nEOF", [['push', '/review']]],
  ["(bash) <<'EOF'\ngit push\nEOF", [['push', '/review']]],
  ["cat <<'EOF' | cat | (sh)\ngit push\nEOF", [['push', '/review']]],
  ["cat <<'EOF' >/tmp/notes | bash\ngit push\nEOF", []],
  ["cat file.txt <<'EOF' | bash\ngit push\nEOF", []],
  ["out=\"$(cat <<'EOF'\ngit commit\nEOF\n)\"", []],
  ['eval \'bash -c "git push"\'', [['push', '/review']]],
  ['bash -lc \'eval "git push"\'', [['push', '/review']]],
  ['echo "$(echo $(git push))"', [['push', '/review']]],
  ['echo "`git push`"', [['push', '/review']]],
  ['echo `echo \\`git push\\``', [['push', '/review']]],
  ['if :; then git push; elif git commit; then :; else git stash; fi', [['push', '/review'], ['commit', '/review'], ['stash', '/review']]],
  ['while git push; do :; done; until git stash; do :; done; ! git commit', [['push', '/review'], ['stash', '/review'], ['commit', '/review']]],
  ['cd /elsewhere | cat; git push', [['push', '/review']]],
  ['echo x | cd /elsewhere; git push', [['push', '/review']]],
  ['cd /elsewhere |\ncat; git push', [['push', '/review']]],
  ['cd /elsewhere && git push & git commit', [['push', '/elsewhere'], ['commit', '/review']]],
  ['cd /elsewhere &&\ngit push & git commit', [['push', '/elsewhere'], ['commit', '/review']]],
  ['GIT_DIR=/elsewhere/.git; env --unset=GIT_DIR git push', [['push', '/review']]],
  ['env --ignore-environment -u GIT_DIR -C /review/sub git push', [['push', '/review/sub']]],
  ['env -C /elsewhere bash -c "git push"', [['push', '/elsewhere']]],
  ['sudo --user bob --group staff -- git push', [['push', '/review']]],
  ['sudo -nu bob git push', [['push', '/review']]],
  ['GIT_DIR=/elsewhere/.git; env -uGIT_DIR git push', [['push', '/review']]],
  ['env -iC/elsewhere git push', [['push', '/elsewhere']]],
  ['xargs -tI {} git push', [['push', '/review']]],
  ['command -pv git commit; command -pV git push', []],
  ['sudo -D /elsewhere -u bob git push', [['push', '/elsewhere']]],
  ['time -o /tmp/timing git push', [['push', '/review']]],
  ['nice -n 10 timeout --signal TERM --kill-after=2 60 xargs -n 1 -I {} git push', [['push', '/review']]],
  ['command -v git commit; command -V git push', []],
  ['builtin git push; exec -a git-process git commit; time -p git stash', [['push', '/review'], ['commit', '/review'], ['stash', '/review']]],
  ["bash -s -- arg <<'EOF'\ngit push\nEOF", [['push', '/review']]],
  ["bash 3<<'EOF'\ngit push\nEOF", []],
  ["bash <<'EOF' </dev/null\ngit push\nEOF", []],
  ["bash release.sh <<'EOF'\ngit push\nEOF", []],
  ["bash <<'EOF'\n(cd /elsewhere; git push)\ngit commit\nEOF", [['push', '/elsewhere'], ['commit', '/review']]],
  ['git --work-tree', []], ['xargs -n', []], ['sudo -u', []],
  ['echo {git,stash}; echo git\\ push; echo "git; push"', []],
];
for (const [command, expected] of parserCases) {
  await test(`shell parser: ${JSON.stringify(command)}`, () => {
    assert.deepEqual(gitWrites(command, '/review', '/home/me').map((write) => [write.action, write.cwd]), expected);
  });
}

const extraHookCases = [
  [`test -n "$x" || cd "${elsewhere}" && git push`, true],
  [`test -n "$x" && cd "${elsewhere}"; git push`, true],
  [`test -n "$x" && cd "${elsewhere}" && test -e x || git push`, true],
  [`if test -e a; then cd "${elsewhere}"; elif test -e b; then :; else git push; fi`, true],
  [`if cd "${elsewhere}"; then git push; else :; fi`, false],
  [`if cd "${elsewhere}"; then :; else git push; fi`, true],
  [`cd "${elsewhere}"; if test -e a; then cd "${repo}"; else git push; fi`, false],
  [`if ! { cd "${elsewhere}"; test -e x; }; then git push; fi`, false],
  [`cd "${elsewhere}"; if ! { cd "${repo}"; test -e x; }; then git push; fi`, true],
  [`! if cd "${elsewhere}"; then :; else git push; fi`, true],
  [`cd "${elsewhere}"; eval 'cd "${repo}"; false' || git push`, true],
  [`case "$x" in a|b) cd "${elsewhere}" ;; c) git push ;; esac`, true],
  [`cd "${elsewhere}"; case "$x" in a) cd "${repo}" ;; b) git push ;; esac`, false],
  [`case "$x" in a) cd "${elsewhere}" ;; esac; git push`, true],
  [`(case "$x" in (a) cd "${elsewhere}" ;; (b) git push ;; esac)`, true],
  ["case x in git|commit) echo 'git commit' ;; esac", false],
  [`cd "${elsewhere}"; case "$x" in a) cd "${repo}" ;& b) git push ;; esac`, true],
  [`cd "${elsewhere}"; case "$x" in a) cd "${repo}" ;;& b) git push ;; esac`, true],
  ["case x in a) echo 'git push' ;& b) cat <<'EOF'\ngit commit\nEOF\n;; esac", false],
  ["if cat <<'EOF'; then\ngit push\nEOF\n:; fi", false],
  ["case x in a) cat <<'EOF' ;;\ngit push\nEOF\nesac", false],
  ["sh -c -- 'git push'", true], ["bash +e -lc -- 'git stash'", true],
  ["zsh +o nomatch -c 'git push'", true], ["set +o noglob; git push", true],
  ['git --attr-source HEAD commit', true], ['git --attr-source=HEAD commit', true],
  [`cd "${elsewhere}"; export GIT_DIR="${repo}/.git"; git push`, true],
  [`export GIT_WORK_TREE="${elsewhere}"; git push`, false],
  ["env -S 'git push'", true], ["env --split-string='git' push", true],
  [`env -S 'git -C "${outsideSpace}"' push`, false], ["env -S 'echo git push'", false],
  ["env -S 'sh -c \"git push\"'", true],
  ["bash <<< 'git push'", true], ["cat <<< 'git push' | sh", true],
  ["cat <<< 'git push'", false], ["sh 3<<< 'git push'", false],
  ["sh <<< 'git push' </dev/null", false], ["cat <<< \"$(git push)\"", true],
  [`pushd "${elsewhere}"; pushd +1; git push`, true],
  [`pushd "${elsewhere}"; pushd +0; git push`, false],
  [`pushd "${elsewhere}"; pushd "${outsideSpace}"; pushd -0; git push`, true],
  [`pushd "${elsewhere}"; pushd +1; popd; git push`, false],
  ...writeActions.flatMap((action) => [
    [`git --git-dir="${repo}/.git" --work-tree="${outsideSpace}" ${action}`, true],
    [`git --work-tree="${outsideSpace}" --git-dir="${repo}/.git" ${action}`, true],
  ]),
  [`GIT_DIR="${repo}/.git" GIT_WORK_TREE="${outsideSpace}" git push`, true],
  [`GIT_WORK_TREE="${outsideSpace}" GIT_DIR="${repo}/.git" git push`, true],
  [`git -C sub --git-dir=../.git --work-tree="${outsideSpace}" commit -m x`, true],
  [`git --git-dir="$REPO/.git" --work-tree="${outsideSpace}" push`, true],
  [`git --git-dir="${elsewhere}/.git" --work-tree="${outsideSpace}" push`, false],
  [`git --git-dir="${repo}/.git" --work-tree="${outsideSpace}" stash list`, false],
  [`git --git-dir="${repo}/.git" --work-tree="${outsideSpace}" stash show`, false],
  ['git --git-dir .git push', true],
  [`GIT_WORK_TREE="${insideSpace}" git commit`, true],
  [`git --git-dir="${elsewhere}/.git" --work-tree "${insideSpace}" push`, true],
  [`git -C "${outsideSpace}" --work-tree "${insideSpace}" push`, true],
  ['builtin git commit', true], ['exec git push', true], ['nice -n 10 git push', true],
  ['xargs -n 1 git push', true], ['time -p git commit', true], ['ls | git push', true],
  ['while git push; do :; done', true], ['until git stash; do :; done', true], ['! git commit', true],
  // A loop body may run zero times: its cd must not move a later write out of the guarded tree.
  [`while false; do cd "${outsideSpace}"; done; git commit -m x`, true],
  [`until true; do cd "${outsideSpace}"; done; git commit -m x`, true],
  [`for d in; do cd "${outsideSpace}"; done; git commit -m x`, true],
  [`for d in a b\ndo\n  cd "${outsideSpace}"\ndone\ngit push`, true],
  ['for d in a $(git push); do :; done', true], ['for d in a b; do git commit -m "$d"; done', true],
  [`for d in a b; do echo "$d"; done; cd "${outsideSpace}" && git push`, false],
  [`while read -r f; do echo "$f"; done < list; cd "${outsideSpace}" && git push`, false],
  // Each ! inverts again: ! ! cd x || git commit runs the commit only when cd failed.
  [`! ! cd "${outsideSpace}" || git commit -m x`, true],
  [`! cd "${outsideSpace}" || git push`, false],
  ['git -C a* push', true], ['git -C `pwd` push', true],
  [`(cd "${outsideSpace}" && git status); git push`, true],
  [`out="$(cd "${outsideSpace}" && git status)"; git push`, true],
  [`cd "${outsideSpace}" && git status & git push`, true],
  ['bash -ic \'eval "git push"\'', true],
  ['cat <<EOF\n$(git push)\nEOF', true],
  ['bash <<-"EOF"\n\tgit push\n\tEOF', true],
  ['cat <<EOF\ngit push\nEOF', false], ['cat <<"EOF"\ngit push\nEOF', false],
  ["echo $'git commit\\\' is a mention'", false],
  ['echo "\\$(git push)"', false], ['echo git#push', false],
  [`GIT_WORK_TREE="${outsideSpace}" git push`, false],
  [`git --git-dir="${elsewhere}/.git" push`, false],
  [`git --work-tree="${outsideSpace}" push`, false],
  [`cd "${outsideSpace}" && git status; git push`, false],
  [`git -C "${insideSpace}/../../elsewhere" push`, false],
  [`git -C "${repo}-other" push`, false],
  ["git -C '~/project' push", true], ['git -C \\~/project push', true],
  ['echo { git push }', false], ['echo } git push', false],
  ['echo ${x:-\'$(git push)\'}', false], ['echo "${x:-"a; git push "}"', false],
  ["cat <<'EOF' | bash\ngit push\nEOF", true],
  ["(bash) <<'EOF'\ngit push\nEOF", true],
  [`cd "${outsideSpace}" || git push`, true],
  [`cd "${outsideSpace}" && GIT_WORK_TREE="${insideSpace}" eval 'git push'`, true],
  [`GIT_WORK_TREE="${outsideSpace}" eval 'git push'`, false],
  ['sudo -nu bob git push', true], ['xargs -tI {} git push', true],
  [`pushd "${outsideSpace}"; pushd; git push`, true],
  ["'FOO=1' git push", false], ['command FOO=1 git push', false],
  ...['bash', 'sh', 'zsh', 'dash', 'ksh'].flatMap((shell) => ['-c', '-lc', '-ic'].map((option) => [
    `${shell} ${option} 'git push'`, true,
  ])),
];
for (const [command, denied] of extraHookCases) {
  await test(`commit guard ${denied ? 'denies' : 'allows'}: ${JSON.stringify(command)}`, async () => {
    const result = await E.bash(command);
    assert.equal(Boolean(result.deny), denied, command);
    assert.equal(result.result, denied ? undefined : 'core reached');
  });
}

for (const [command, dirs] of [
  ['git --git-dir=/review/.git --work-tree=/elsewhere commit', ['/elsewhere', '/review/.git']],
  ['git --work-tree=/elsewhere --git-dir=/review/.git commit', ['/elsewhere', '/review/.git']],
  ['GIT_DIR=/review/.git GIT_WORK_TREE=/elsewhere git push', ['/elsewhere', '/review/.git']],
  ['git -C sub --git-dir=../.git --work-tree=../../elsewhere push', ['/review/sub/../../elsewhere', '/review/sub/../.git']],
  ['git --git-dir=$REPO/.git --work-tree=/elsewhere push', ['/elsewhere', null]],
  ['git --git-dir=/review/.git push', ['/review/.git']],
]) {
  await test(`shell parser reports every affected directory: ${JSON.stringify(command)}`, () => {
    assert.deepEqual(gitWrites(command, '/review', '/home/me').map((write) => write.dirs), [dirs]);
  });
}

await test("context note: on the person's own messages in the Claude session that drives the review", async () => {
  const typed = await E.prompt('как дела?');
  assert.match(typed.context.join('\n'), new RegExp(`^\\[agent-duet\\] Активная сессия ревью ${id}`));
  assert.ok(typed.context.join('\n').includes(`node "${installed}/scripts/duet.mjs" status --session ${id}`), 'the runner where the plugin is installed');
  assert.ok((await E.prompt('с телефона', 'bridge')).context, 'Remote Control is the person too');
  assert.equal((await E.prompt('<task-notification>', 'task-notification')).context, undefined);
  E.setCwd(elsewhere);
  assert.ok((await E.prompt('из другой папки')).context, 'ownership, not the folder, decides; other sessions are tested below');
  E.setCwd(repo);
});

await test('Stop hold: Claude ran the runner and stopped while the loop waits on it: sent back once', async () => {
  await E.bash(`${RUNNER} status --session ${id}`);
  const r = await E.stop();
  assert.match(r.block ?? '', new RegExp(`^agent-duet ${id}: раунд 1/10 закончен, открыто 2: .*reply`));
  assert.equal((await E.stop({ stop_hook_active: true })).block, undefined);
});

await test('Stop hold: quiet for a question, background work, a scheduled wake-up', async () => {
  assert.equal((await E.stop({ last_assistant_message: 'Исправить C1 так?' })).block, undefined);
  const task = { id: 'b1', type: 'shell', status: 'running', description: 'round 2' };
  assert.equal((await E.stop({ background_tasks: [task] })).block, undefined);
  assert.equal((await E.stop({ session_crons: [{ id: 'c1' }] })).block, undefined);
});

await test("Stop hold: the person's message the loop did not answer lets Claude stop; a notification's turn does not", async () => {
  await E.prompt('а что такое C2?');
  assert.equal((await E.stop()).block, undefined);
  await E.bash(`${RUNNER} status --session ${id}`, { agentId: 'sub-1' });
  assert.equal((await E.stop()).block, undefined, "a subagent's run is not Claude answering");
  await E.bash(`${RUNNER} status --session ${id}`);
  assert.ok((await E.stop()).block);
  await E.prompt('<task-notification>', 'task-notification');
  assert.ok((await E.stop()).block);
});

await test('escalation: decision cue and toast, footer asks for you, the pane sends the chosen side to Claude', async () => {
  const r = duet(['reply', '--session', id, '--responses', '-'], responses([
    { id: 'C1', action: 'disputed', note: 'not reachable' },
    { id: 'C2', action: 'fixed', note: 'done' },
  ]));
  assert.equal(r.code, 0, r.err);
  await E.tick();
  assert.deepEqual(E.sounds, ['tool_approval_needed.mp3']);
  assert.ok(E.toasts.some((t) => /нужно твоё решение — C1/.test(t)));
  assert.match(lines(await E.render('AbovePrompt'))[0], /ждёт твоего решения: C1/);
  assert.deepEqual(await footer(E), ['[Duet 🙋 нужен ты]']);
  assert.equal((await E.stop()).block, undefined, 'escalated: the owner moves next');
  await E.press(await E.render('Pane'), 'pick-codex-C1');
  await E.press(await E.render('Pane'), 'send-decisions');
  assert.match(E.submitted.at(-1), new RegExp(`^agent-duet ${id}: мои решения[\\s\\S]*C1: прав Codex`));
});

await test('the board: a long title wraps whole beside its badge, an issue unfolds to both sides, closed issues fold away', async () => {
  const long = 'Строка с теми же полями в другом порядке проходит проверку, хотя схема требует порядок колонок'.repeat(3);
  rewrite(id, (st) => ({ issues: { ...st.issues, C1: { ...st.issues.C1, title: long } } }));
  await E.tick();
  let tree = await E.render('Pane');
  let rows = lines(tree);
  const title = nodes(tree).find((n) => n.type === 'Text' && n.children.join('').endsWith(long));
  assert.equal(title?.props.wrap, 'wrap', rows.join('\n'));
  assert.ok(!rows.some((l) => l.endsWith('…')), `the mod cuts no text but the task list's labels:\n${rows.join('\n')}`);
  assert.ok(rows.includes('[▸ закрытые · 1]') && !rows.includes('Issue C2'), `C2 is closed and folds while C1 is open:\n${rows.join('\n')}`);
  await E.press(tree, `fold-${id}:C1`);
  rows = lines(await E.render('Pane'));
  const unfolded = rows.slice(rows.indexOf('[▾]'));
  assert.deepEqual(unfolded.slice(3, 6), ['Codex: Still reachable', 'Claude (возразил): not reachable', 'споров: 1'], rows.join('\n'));
  await E.press(await E.render('Pane'), 'fold-closed');
  assert.ok(lines(await E.render('Pane')).includes('Issue C2'));
});

await test('the sound toggle: off silences the cues, toasts stay; the setting is saved', async () => {
  let pane = await E.render('Pane');
  assert.ok(lines(pane).includes('[▸ Настройки: строка вкл · звук вкл]'), 'the switches fold away under one line');
  await E.press(pane, 'settings');
  pane = await E.render('Pane');
  await E.press(pane, 'pref-sound');
  assert.equal(E.stored.get('prefs').sound, false);
  const r = duet(['reply', '--session', id, '--responses', '-'], responses([{ id: 'C1', action: 'owner-decided', note: 'owner: keep' }]));
  assert.equal(r.code, 0, r.err);
  await E.tick();
  assert.deepEqual(E.sounds, ['tool_approval_needed.mp3'], 'no done cue while muted');
  assert.ok(E.toasts.some((t) => /ревью завершено за 3/.test(t)));
  assert.match(lines(await E.render('AbovePrompt'))[0], /✅ готово · проверка: неизвестно/, 'a recently finished review shows its verification');
  assert.equal(await E.render('SessionMode'), BELOW);
  assert.equal((await E.command('duet', 'sound on')).text, 'agent-duet sound: вкл');
});

await test("/duet sound test: the Claude app's sounds in turn; without the app or a working afplay, the plugin's own", async () => {
  const hear = async () => {
    const before = E.sounds.length;
    assert.match((await E.command('duet', 'sound test')).text, /эскалация → конец ревью → сбой/);
    await waitFor(() => E.sounds.length >= before + 3);
    return E.sounds.slice(before);
  };
  assert.deepEqual(await hear(), APP_SOUNDS);
  setAppSounds(false);
  assert.deepEqual(await hear(), SYNTH_SOUNDS, 'no app: the synthesized cues');
  setAppSounds(true);
  E.setAfplayExit(1);
  assert.deepEqual(await hear(), SYNTH_SOUNDS, 'afplay failed: the engine plays the synthesized cues');
  E.setAfplayExit(0);
});

let failed;
await test('a failed round sounds the error cue', async () => {
  scriptCodex([{ fail: 'simulated network error' }]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 3;\n');
  const r = duet(['start', '--kind', 'code']);
  assert.equal(r.code, 1);
  failed = sessionId(r.out + r.err) ?? fs.readdirSync(home).filter((n) => n !== id && !n.startsWith('.')).at(-1);
  await E.tick();
  assert.equal(E.sounds.at(-1), 'disconnected.mp3');
  assert.deepEqual(await footer(E), ['[Duet ⚠️ сбой]']);
});

await test('a running turn: the band names its model, the pane shows it and wraps what Codex says', async () => {
  const long = `I will ${'carefully check one more thing, '.repeat(12)}then report.`;
  const said = { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: long } };
  fs.writeFileSync(path.join(home, failed, 'round-1.events.jsonl'), `${JSON.stringify(said)}\n`);
  const codexModel = { model: 'gpt-6.1-sol', effort: 'max', fromConfig: ['model', 'effort'] };
  rewrite(failed, () => ({ phase: 'awaiting-codex', pending: { round: 1, startedAt: new Date().toISOString(), codexModel } }));
  fs.writeFileSync(path.join(home, failed, 'lock'), String(process.pid)); // a runner that lives
  await E.tick();
  assert.match(lines(await E.render('AbovePrompt'))[0], /^⏳ Codex gpt-6\.1-sol\/max · r1\/10 · /);
  const pane = await E.render('Pane');
  assert.ok(lines(pane).includes('Модель: gpt-6.1-sol (из конфига) · max (из конфига)'), lines(pane).join('\n'));
  // markdown, which every surface wraps as it wraps a reply
  const words = nodes(pane).find((n) => n.type === 'Markdown' && n.props.text.startsWith('Codex: I will'));
  assert.equal(words?.props.text, `Codex: ${long}`, 'whole, not cut to one line');
});

await test('Fast: ⚡ on the band and in the pane while a turn runs in Fast; "(из конфига)" until Codex logs it', async () => {
  const runAs = async (tier, fromConfig) => {
    rewrite(failed, (st) => ({ pending: { ...st.pending, codexModel: { model: 'gpt-6.1-sol', effort: 'max', fromConfig, tier } } }));
    await E.tick();
    return { band: lines(await E.render('AbovePrompt'))[0], pane: lines(await E.render('Pane')) };
  };
  const asked = await runAs('priority', ['model', 'effort', 'tier']);
  assert.match(asked.band, /^⏳ Codex gpt-6\.1-sol\/max ⚡ · r1\/10 · /);
  assert.ok(asked.pane.includes('Модель: gpt-6.1-sol (из конфига) · max (из конфига) · ⚡ Fast (из конфига)'), asked.pane.join('\n'));
  const logged = await runAs('priority', ['model', 'effort']);
  assert.ok(logged.pane.includes('Модель: gpt-6.1-sol (из конфига) · max (из конфига) · ⚡ Fast'), logged.pane.join('\n'));
  const standard = await runAs('default', ['model', 'effort']);
  assert.match(standard.band, /^⏳ Codex gpt-6\.1-sol\/max · r1\/10 · /);
  assert.ok(!standard.pane.some((l) => l.includes('⚡')), standard.pane.join('\n'));
});

// ---- a quiet stream: how old Codex's words are, how long it has thought, whether its own log still grows
const MIN = 60_000;
const past = (ms) => new Date(Date.now() - ms);
// the running round's event stream as the runner writes it, last grown `quietMs` ago
const stream = (sid, events, quietMs) => {
  const file = path.join(home, sid, 'round-1.events.jsonl');
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  fs.utimesSync(file, past(quietMs), past(quietMs));
  return file;
};
const ran = (id, command, at) => [
  { type: 'item.started', item: { id, type: 'command_execution', command }, _at: at },
  { type: 'item.completed', item: { id, type: 'command_execution', command, exit_code: 0 }, _at: at },
];

await test('a quiet stream: the words show their age, the pane says how long Codex thinks and how fresh its own log is', async () => {
  const thread = '01a1-quiet-thread';
  const log = path.join(tmp, 'no-codex-home', 'sessions', '2026', '10', '04', `rollout-2026-10-04T00-32-25-${thread}.jsonl`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, '{}\n');
  const touchLog = () => fs.utimesSync(log, past(20_000), past(20_000));
  const started = { type: 'thread.started', thread_id: thread, _at: past(60 * MIN).toISOString() };
  const said = { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Closing the bypass now.' }, _at: past(30 * MIN).toISOString() };
  stream(failed, [started, said, ...ran('c1', "/bin/zsh -lc 'git status'", past(15 * MIN).toISOString())], 15 * MIN);
  touchLog();
  await E.tick();
  assert.match(lines(await E.render('AbovePrompt'))[0], /· думает 15 мин(?: ·|$)/, 'the band does not pass old words for news');
  let pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => /^Сейчас: думает 15 мин · журнал Codex обновлён 2\d с назад$/.test(l)), pane.join('\n'));
  assert.ok(pane.includes('Codex, 30 мин назад: Closing the bypass now.'), pane.join('\n'));
  // a runner from before 0.7.2 stamps nothing: the words are at least as old as the silence after them
  const bare = (e) => ({ ...e, _at: undefined });
  stream(failed, [started, said, ...ran('c1', "/bin/zsh -lc 'git status'")].map(bare), 15 * MIN);
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex, больше 15 мин назад: Closing the bypass now.'), pane.join('\n'));
  // a long command: what it runs and for how long; a stream that just grew needs no age at all
  stream(failed, [started, { type: 'item.started', item: { id: 'c2', type: 'command_execution',
    command: "/bin/zsh -lc '/bin/bash scripts/test_import.sh > log 2>&1; tail -2 log'" } }].map(bare), 6 * MIN);
  touchLog();
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => /^Сейчас: запускает scripts\/test_import\.sh · 6 мин · журнал Codex обновлён 2\d с назад$/.test(l)), pane.join('\n'));
  stream(failed, [started, said].map(bare), 0);
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex: Closing the bypass now.'), pane.join('\n'));
  // markdown keeps its paragraphs and list in the pane; the band takes it as one line
  const listed = { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'Checked `parser`.  \n\n\n- one\n- two' } };
  stream(failed, [started, listed].map(bare), 0);
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex: Checked `parser`.\n\n- one\n- two'), pane.join('\n'));
  assert.match(lines(await E.render('AbovePrompt'))[0], /· Checked `parser`\. - one - two/);
});

await test('commands read as what they do: the script it runs, the file after the options, no bare flags or long paths', async () => {
  const commands = [
    "/bin/zsh -lc 'IMPORT_TEST_REPORT=\"$PWD/r.tsv\" /bin/bash scripts/test_import.sh > .import-new.log 2>&1; result=$?; tail -2 .import-new.log'",
    "/bin/zsh -lc 'git diff --stat | tail -2'",
    "/bin/zsh -lc 'tail -n 20 build.log'",
    "/bin/zsh -lc 'tail -2 .import-old.log'",
    "/bin/zsh -lc 'PYTHONDONTWRITEBYTECODE=1 /Users/x/.codex/venvs/common/bin/python /Users/x/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/my-skill'",
    "/bin/zsh -lc 'LANG=C /opt/homebrew/bin/jq -r .version /Users/x/proj/package.json'",
  ];
  stream(failed, commands.flatMap((command, n) => ran(`k${n}`, command)), 0);
  await E.tick();
  const shown = lines(await E.render('Pane')).filter((l) => l.startsWith('  · ')).map((l) => l.slice(4));
  assert.deepEqual(shown, [
    'запускает scripts/test_import.sh',
    'git diff',
    'читает build.log',
    'читает .import-old.log',
    'запускает scripts/quick_validate.py',
    '…/jq -r .version …/package.json',
  ]);
  // code fed on stdin says nothing in its first line; a test run names its suite, never a redirection
  const more = [
    "/bin/zsh -lc \"python3 - <<'PY'\nimport json,sys\nsys.path.insert(0, '.')\nPY\"",
    "/bin/zsh -lc 'python3 -m unittest tests.test_importer_parse_rows'",
    "/bin/zsh -lc 'npm test 2>&1 | tail -5'",
    "/bin/zsh -lc 'node -e \"console.log(1)\"'",
  ];
  stream(failed, more.flatMap((command, n) => ran(`m${n}`, command)), 0);
  await E.tick();
  assert.deepEqual(lines(await E.render('Pane')).filter((l) => l.startsWith('  · ')).map((l) => l.slice(4)), [
    'запускает скрипт Python',
    'запускает тесты tests.test_importer_parse_rows',
    'запускает тесты',
    'запускает скрипт Node',
  ]);
});

await test('a stream past 4 MiB is read from its end: the latest words and the count of every command', async () => {
  const pad = 'x'.repeat(100_000);
  const big = [{ type: 'thread.started', thread_id: 'big-thread' }];
  for (let n = 0; n < 45; n += 1) {
    big.push({ type: 'item.started', item: { id: `b${n}`, type: 'command_execution', command: "/bin/zsh -lc 'git log'" } });
    big.push({ type: 'item.completed', item: { id: `b${n}`, type: 'command_execution', command: "/bin/zsh -lc 'git log'", aggregated_output: pad } });
  }
  big.push({ type: 'item.completed', item: { id: 'm9', type: 'agent_message', text: 'The latest words.' } });
  const file = stream(failed, big, 0);
  assert.ok(fs.statSync(file).size > 4_194_304, 'past what $.fs.read takes');
  await E.tick();
  const pane = lines(await E.render('Pane'));
  assert.ok(pane.includes('Codex: The latest words.'), pane.join('\n'));
  assert.ok(pane.includes('команд выполнено: 45'), pane.join('\n'));
});

await test('a runner gone mid-round: error cue and toast once, footer asks for retry', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  rewrite(failed, () => ({ phase: 'awaiting-codex', pending: { round: 1, startedAt: new Date().toISOString() } }));
  fs.writeFileSync(path.join(home, failed, 'lock'), String(dead));
  const before = E.sounds.length;
  await E.tick();
  assert.deepEqual(E.sounds.slice(before), ['disconnected.mp3']);
  assert.ok(E.toasts.some((t) => /процесс раунда 1 пропал/.test(t)));
  await E.tick();
  assert.equal(E.sounds.length, before + 1, 'once per round');
  assert.deepEqual(await footer(E), ['[Duet ⚠️ retry]']);
});

await test("build: Codex works in a worktree outside the project, yet the hold and the note follow the project", async () => {
  // as initBuildSubject leaves it: the session's cwd is its worktree, under the session's own folder
  const worktree = path.join(home, failed, 'worktree');
  rewrite(failed, () => ({
    kind: 'build', cwd: worktree, subject: { repo, worktree, branch: 'agent-duet/x' }, phase: 'awaiting-review', round: 1, pending: null,
  }));
  await E.tick();
  await E.bash(`${RUNNER} status --session ${failed}`);
  assert.match((await E.stop()).block ?? '', /Codex закончил раунд 1\/10 и ждёт ревью: .*review/);
  assert.ok((await E.prompt('как там build?')).context, "the note reaches the owner's messages in the project");
  assert.match((await E.bash(`git -C ${worktree} commit -m x`)).deny ?? '', /идёт ревью/, 'no commits in the worktree: finish makes them');
  assert.equal((await E.bash('git commit -m x')).result, 'core reached', "the project's own checkout stays the owner's");
  assert.deepEqual(await footer(E), ['[Duet r1 🔍]']);
});

let foreign;
await test("another Claude session's review: no band, footer, toasts, sounds or hold here; the pane names it; the guard holds", async () => {
  rewrite(failed, () => ({ phase: 'finished' }));
  await E.tick();
  scriptCodex([
    turn('revise', [issue('C1', 'open')]),
    turn('revise', [issue('C1', 'open', 'high', { reply: 'Still reachable' })]),
    turn('approve', [issue('C1', 'resolved')]),
  ]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 5;\n');
  const before = [E.toasts.length, E.sounds.length, E.opened.length];
  const r = duet(['start', '--kind', 'code'], '', { CLAUDE_CODE_SESSION_ID: 'claude-other' });
  assert.equal(r.code, 0, r.err);
  foreign = sessionId(r.out);
  await E.tick();
  assert.equal(await E.render('AbovePrompt'), BELOW);
  assert.equal(await E.render('SessionMode'), BELOW);
  assert.deepEqual([E.toasts.length, E.sounds.length, E.opened.length], before, 'nothing announced here');
  const pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => l.includes('ведёт другая сессия Claude')) && pane.some((l) => l.includes(foreign)), pane.join('\n'));
  await E.bash(`${RUNNER} status --session ${foreign}`);
  assert.equal((await E.stop()).block, undefined, 'not this session to keep going');
  assert.equal((await E.prompt('что там у Codex?')).context, undefined);
  assert.match((await E.bash('git commit -m x')).deny ?? '', /идёт ревью/, 'the repository is guarded from every session');
});

await test('a reply from this session takes the review over: band, footer and cues come here', async () => {
  const r = duet(['reply', '--session', foreign, '--responses', '-'], responses([{ id: 'C1', action: 'disputed', note: 'not reachable' }]));
  assert.equal(r.code, 0, r.err);
  const before = E.sounds.length;
  await E.tick();
  assert.deepEqual(E.sounds.slice(before), ['tool_approval_needed.mp3'], 'round 2 escalates, and the cue sounds here now');
  assert.match(lines(await E.render('AbovePrompt'))[0], /ждёт твоего решения: C1/);
  assert.deepEqual(await footer(E), ['[Duet 🙋 нужен ты]']);
  assert.ok(!lines(await E.render('Pane')).some((l) => l.includes('другая сессия')));
});

await test('a second Claude session sees none of it; a review from before owners shows everywhere, but an old change is not news', async () => {
  const other = await boot(compiled, { options: { language: 'ru' }, env: { HOME: os.homedir(), AGENT_DUET_HOME: home, CODEX_HOME: baseEnv.CODEX_HOME }, cwd: repo, sessionId: 'claude-third' });
  await other.tick();
  assert.equal(await other.render('AbovePrompt'), BELOW);
  // no owner, last written an hour ago: a review from before 0.6.0 that a fresh session meets for the first time
  const st = JSON.parse(fs.readFileSync(stateFile(foreign), 'utf8'));
  delete st.owner;
  st.updatedAt = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(stateFile(foreign), JSON.stringify(st));
  const late = await boot(compiled, { options: { language: 'ru' }, env: { HOME: os.homedir(), AGENT_DUET_HOME: home, CODEX_HOME: baseEnv.CODEX_HOME }, cwd: repo, sessionId: 'claude-fourth' });
  await late.tick();
  assert.match(lines(await late.render('AbovePrompt'))[0], /ждёт твоего решения: C1/, 'shown here, as before owners');
  assert.deepEqual([late.sounds.length, late.toasts.length], [0, 0], 'an hour-old state is history, not a cue');
  // without an owner the hold keeps its old test: this session ran the runner, and sits in the project
  const waiting = JSON.parse(fs.readFileSync(stateFile(foreign), 'utf8'));
  waiting.phase = 'awaiting-author';
  fs.writeFileSync(stateFile(foreign), JSON.stringify(waiting));
  assert.equal((await late.stop()).block, undefined, 'a session that never ran the runner is left alone');
  await late.bash(`${RUNNER} status --session ${foreign}`);
  assert.match((await late.stop()).block ?? '', new RegExp(`^agent-duet ${foreign}:`));
});

await test('the commit guard covers every running review, not only the one this session shows', async () => {
  // the build from before runs again, now driven by another Claude session; this one shows its own review
  rewrite(failed, () => ({ phase: 'awaiting-review', owner: 'claude-other' }));
  await E.tick();
  assert.notEqual(lines(await E.render('Pane'))[1]?.startsWith(failed), true, 'not the review on screen');
  const worktree = path.join(home, failed, 'worktree');
  assert.match((await E.bash(`git -C ${worktree} commit -m x`)).deny ?? '', /идёт ревью/);
});

// ---- several tasks of one Claude session: the list, the queue, cues per task
// Sessions written by hand, as the runner would leave them; ids from the future sort as the newest.
const craft = (sid, fields) => {
  const base = JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
  fs.mkdirSync(path.join(home, sid), { recursive: true });
  fs.writeFileSync(stateFile(sid), JSON.stringify({
    ...base, id: sid, owner: 'claude-me', issues: {}, rounds: [], decision: null, updatedAt: new Date().toISOString(), ...fields,
  }));
};
const buildOf = (branch, prefix = 'agent-duet') => ({
  kind: 'build', cwd: path.join(home, `wt-${branch}`),
  subject: { repo, worktree: path.join(home, `wt-${branch}`), branch: `${prefix}/${branch}` },
});
const T = { one: '20991231-000001-aaaa', two: '20991231-000002-bbbb', three: '20991231-000003-cccc' };
const ago = (ms) => new Date(Date.now() - ms).toISOString();

await test('several tasks: the pane lists them, a row opens its details, footer and status line sum them up', async () => {
  const codexModel = { model: 'gpt-6.1-sol', effort: 'max', fromConfig: ['model', 'effort'] };
  craft(T.one, { ...buildOf('task-one'), phase: 'awaiting-codex', round: 0, pending: { round: 1, startedAt: ago(65_000), codexModel } });
  craft(T.two, { ...buildOf('task-two', 'codex-duet'), phase: 'queued', round: 0, pending: { round: 1, queuedAt: ago(30_000) } });
  craft(T.three, { ...buildOf('task-three'), phase: 'escalated', round: 2, decision: { action: 'escalate', reason: 'r', issues: ['C1'] } });
  for (const sid of [T.one, T.two]) fs.writeFileSync(path.join(home, sid, 'lock'), String(process.pid));
  await E.tick();
  const rows = lines(await E.render('Pane'));
  assert.ok(rows.some((l) => /^Задачи · идут 1 · в очереди 1 · всего \d+$/.test(l)), rows.join('\n'));
  assert.ok(rows.some((l) => /⏳ task-one · раунд 1\/10 · 1:0\d · gpt-6\.1-sol\/max\]$/.test(l)), rows.join('\n'));
  assert.ok(rows.some((l) => l.includes('⏸ task-two · в очереди: 1-я')));
  assert.ok(rows.some((l) => l.includes('🙋 task-three · нужно твоё решение: C1')));
  assert.ok(E.toasts.some((t) => t === 'task-two: раунд 1 ждёт в очереди к Codex'), E.toasts.slice(-5).join('\n'));
  await E.press(await E.render('Pane'), `task-${T.two}`);
  const detail = lines(await E.render('Pane'));
  assert.ok(detail.some((l) => l.startsWith(`${T.two} · `)) && detail.some((l) => l.startsWith('⏸ ждёт свободного Codex, в очереди 1-я')), detail.join('\n'));
  assert.match((await footer(E))[0], /^\[Duet ×\d+ ⏳1 ⏸1 🙋\]$/);
  assert.equal(E.statuses.at(-1), 'agent-duet: идут 1 · в очереди 1');
  assert.match(lines(await E.render('AbovePrompt'))[0], / · ещё задач: \d+$/);
});

await test('cues per task: each toast names its task, and one read sounds once, the decision first', async () => {
  const before = { sounds: E.sounds.length, toasts: E.toasts.length };
  craft(T.one, { ...buildOf('task-one'), phase: 'escalated', round: 1, decision: { action: 'escalate', reason: 'r', issues: ['C2'] } });
  craft(T.three, { ...buildOf('task-three'), phase: 'done', round: 3 });
  await E.tick();
  const toasts = E.toasts.slice(before.toasts);
  assert.ok(toasts.includes('task-one: agent-duet: нужно твоё решение — C2. Панель: /duet'), toasts.join('\n'));
  assert.ok(toasts.includes('task-three: agent-duet: ревью завершено за 3 раунда ✓'), toasts.join('\n'));
  assert.deepEqual(E.sounds.slice(before.sounds), ['tool_approval_needed.mp3'], 'two cues raised, one played: the decision');
});

await test('the Stop hold names every task that waits on Claude', async () => {
  craft(T.one, { ...buildOf('task-one'), phase: 'awaiting-review', round: 1 });
  craft(T.two, { ...buildOf('task-two'), phase: 'awaiting-review', round: 1 });
  await E.tick();
  await E.bash(`${RUNNER} status --session ${T.one}`);
  const block = (await E.stop()).block ?? '';
  assert.match(block, /^agent-duet: твоего хода ждут \d+ сессии — /);
  assert.match(block, /task-one: ревью раунда 1\/10/);
  assert.match(block, /task-two: ревью раунда 1\/10/);
});

await test('an audit: the list names it by its task; done, the pane shows its result and findings and no score', async () => {
  const sid = '20991231-000004-dddd';
  const auditOf = { kind: 'audit', cwd: repo, maxRounds: 1, subject: { task: path.join(home, sid, 'task.md'), title: 'Audit the ledger rechecks' } };
  craft(sid, { ...auditOf, phase: 'awaiting-codex', round: 0, pending: { round: 1, startedAt: ago(20_000) } });
  fs.writeFileSync(path.join(home, sid, 'lock'), String(process.pid));
  await E.tick();
  assert.ok(lines(await E.render('Pane')).some((l) => l.includes('⏳ Audit the ledger rechecks · раунд 1/1 · 0:2')));
  await E.press(await E.render('Pane'), `task-${sid}`);
  let pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => l.startsWith('⏳ Codex проводит аудит · 0:2')), pane.join('\n'));
  const before = E.toasts.length;
  craft(sid, {
    ...auditOf, phase: 'done', round: 1,
    findings: [
      { id: 'A1', severity: 'high', title: 'Stale outcome survives a recheck', location: 'ledger.py:38-44' },
      { id: 'A2', severity: 'low', title: 'Errored tickets vanish', location: '' },
    ],
    audit: { summary: 'Two stale outcomes.', coverage: 'Read ledger.py.', notes: '' },
    rounds: [{ n: 1, verdict: null, startedAt: ago(20_000), finishedAt: ago(0), open: 2, parked: 0 }],
    decision: { action: 'done', reason: 'audit finished, findings: 2', issues: [] },
  });
  await E.tick();
  pane = lines(await E.render('Pane'));
  assert.ok(pane.some((l) => l.includes('✅ аудит · Audit the ledger rechecks · находок 2')), pane.join('\n'));
  assert.ok(pane.includes('Итог: Two stale outcomes.') && pane.includes('Находки · 2'), pane.join('\n'));
  const at = pane.findIndex((l) => /^● A1 +high/.test(l));
  assert.equal(pane[at + 1], 'Stale outcome survives a recheck — ledger.py:38-44', pane.join('\n'));
  assert.ok(!pane.includes('Табло') && !pane.some((l) => l.startsWith('Замечания')), 'nothing to negotiate or score');
  assert.ok(E.toasts.slice(before).some((t) => t.endsWith('agent-duet: аудит готов, находок 2 ✓')), E.toasts.slice(before).join('\n'));
});

// Language choices use their own session folders so the owner's shell locale and the preceding reviews
// cannot decide what these engines display. The text written by Codex and the policy remains untouched.
const LANGUAGE_TEXT = {
  en: {
    empty: /No agent-duet sessions found\./,
    pane: /Issues/,
    band: /Claude’s turn: 2 issues/,
    toast: /round 1/,
    footer: /Duet 🙋 your decision/,
    context: /Active review session/,
    hold: /round 1\/10 is complete, 2 open/,
    deny: /a review is in progress/,
    decisions: /my decisions/,
    codex: /Codex is right/,
    ownerMarker: /Owner decision: fix/,
  },
  ru: {
    empty: /Сессий agent-duet не найдено\./,
    pane: /Замечания/,
    band: /ход Claude/,
    toast: /раунд 1/,
    footer: /нужен ты/,
    context: /Активная сессия ревью/,
    hold: /раунд 1\/10 закончен/,
    deny: /идёт ревью/,
    decisions: /мои решения/,
    codex: /прав Codex/,
    ownerMarker: /Решение владельца: исправить/,
  },
  zh: {
    empty: /未找到 agent-duet 会话。/,
    pane: /问题 · 2 个未解决/,
    band: /轮到 Claude：2 个问题/,
    toast: /第 1 轮/,
    footer: /Duet 🙋 等你决定/,
    context: /活跃审查会话/,
    hold: /第 1\/10 轮已完成，还有 2 个未解决问题/,
    deny: /正在进行审查/,
    decisions: /我对争议问题的决定/,
    codex: /Codex 是对的/,
    ownerMarker: /所有者决定：修复/,
  },
};
let languageFixture = 0;
async function languageEngine(options, localeEnv = {}, defaultsResult) {
  const stateHome = path.join(tmp, `language-${++languageFixture}`);
  fs.mkdirSync(stateHome);
  const engine = await boot(compiled, {
    options, defaultsResult, cwd: repo,
    env: { HOME: os.homedir(), AGENT_DUET_HOME: stateHome, CODEX_HOME: baseEnv.CODEX_HOME, ...localeEnv },
  });
  const sid = '20991231-123456-abcd';
  const write = (fields = {}) => {
    fs.mkdirSync(path.join(stateHome, sid), { recursive: true });
    fs.writeFileSync(path.join(stateHome, sid, 'state.json'), JSON.stringify({
      id: sid, kind: 'code', cwd: repo, owner: 'claude-me', subject: { mode: 'diff' },
      round: 1, maxRounds: 10, phase: 'awaiting-author', updatedAt: new Date().toISOString(),
      rounds: [{ n: 1, verdict: 'revise', startedAt: ago(10_000), finishedAt: ago(0), open: 2, parked: 0 }],
      codex: { model: null, effort: null },
      issues: { C1: { ...issue('C1', 'open'), disputes: 1 }, C2: { ...issue('C2', 'open', 'medium'), disputes: 0 } },
      decision: { action: 'continue', reason: 'Open issues remain', issues: [] },
      ...fields,
    }));
  };
  return { engine, sid, write, stateHome };
}

await test('discard releases a code review from pane focus, commit guard, Stop hold and context', async () => {
  const { engine, sid, write, stateHome } = await languageEngine({ language: 'en' });
  const rerun = '20991231-123457-abcd';
  const state = (id) => path.join(stateHome, id, 'state.json');
  write({ issues: { C1: { ...issue('C1', 'open'), openedRound: 1, history: [] } } });
  fs.mkdirSync(path.dirname(state(rerun)));
  fs.writeFileSync(state(rerun), JSON.stringify({
    ...JSON.parse(fs.readFileSync(state(sid), 'utf8')), id: rerun, kind: 'audit', phase: 'done',
    subject: { title: 'Successful rerun' }, findings: [], audit: { summary: 'Complete' },
  }));
  await engine.tick();
  const detail = async (id) => lines(await engine.render('Pane')).some((line) => line.startsWith(`${id} · `));
  assert.ok(await detail(sid), 'the active review gets default focus');
  await engine.press(await engine.render('Pane'), `task-${sid}`);
  await engine.bash(`${RUNNER} status --session ${sid}`);
  assert.ok((await engine.bash('git commit')).deny?.includes(sid));
  assert.ok((await engine.stop()).block?.includes(sid));
  assert.ok((await engine.prompt('Progress?')).context?.join('').includes(sid));
  await engine.bash(`${RUNNER} status --session ${sid}`); // mark the person's prompt answered

  const closed = duet(['discard', '--session', sid], '', { AGENT_DUET_HOME: stateHome });
  assert.equal(closed.code, 0, closed.err);
  await engine.tick();
  assert.equal(engine.atoms.get('agent-duet:focus'), '');
  assert.ok(await detail(rerun), 'the completed task takes focus');
  assert.equal((await engine.bash('git commit')).result, 'core reached');
  assert.equal((await engine.stop()).block, undefined);
  assert.equal((await engine.prompt('Progress?')).context, undefined);
  const pane = await engine.render('Pane');
  const closedRow = nodes(pane).find((n) => n.props.key === `task-${sid}`);
  assert.match(closedRow?.props.label ?? '', /discarded/);
  await engine.press(pane, `task-${sid}`);
  await engine.tick();
  assert.ok(await detail(sid), 'the closed task can still be inspected');
  assert.match(lines(await engine.render('Pane')).join('\n'), /🗑 discarded/);
});

await test('Dismiss needs an idle, owned or ownerless failure, and toasts the runner result', async () => {
  const stateHome = path.join(tmp, 'dismiss-runners');
  const pluginRoot = path.join(tmp, 'installed Dismiss plugin');
  fs.symlinkSync(path.dirname(path.dirname(DUET)), pluginRoot);
  const env = { ...baseEnv, AGENT_DUET_HOME: stateHome };
  scriptCodex([{ fail: 'delegate interrupted' }]);
  const start = duet(['start', '--kind', 'audit', '--subject', '-'], '# Failed audit\n', env);
  assert.equal(start.code, 1, start.err);
  const sid = /retry --session (\S+)/.exec(start.err)?.[1];
  const ledger = path.join(stateHome, sid, 'state.json');
  const failed = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  const lock = path.join(stateHome, sid, 'lock');
  const write = (fields) => fs.writeFileSync(ledger, JSON.stringify({ ...failed, ...fields }));
  const command = ['node', `${pluginRoot}/scripts/duet.mjs`, 'discard', '--session', sid];
  const refusal = `agent-duet: session ${sid} is busy: another agent-duet call is running; wait for it to finish`;
  let calls = 0;
  const engine = await boot(compiled, { env, cwd: repo, root: pluginRoot, options: { language: 'en' }, onProcess: (argv) => {
    if (argv[2] !== 'discard') return;
    assert.deepEqual(argv, command);
    if (++calls === 1) return { exitCode: 2, stdout: '', stderr: `${refusal}\n` };
  } });
  const dismiss = async () => nodes(await engine.render('Pane')).find((n) => n.props.key === 'dismiss');
  assert.equal((await dismiss())?.props.label, 'Dismiss');
  fs.writeFileSync(lock, String(process.pid));
  await engine.tick();
  assert.equal(await dismiss(), undefined, 'the runner is still alive with a recorded failure');
  fs.rmSync(lock);
  await engine.tick();
  assert.ok(await dismiss(), 'the button appears once the lock is released without a ledger write');
  const stalePane = await engine.render('Pane');
  write({ owner: 'another-claude' });
  await engine.press(stalePane, 'dismiss');
  assert.equal(engine.toasts.at(-1), 'This task belongs to another Claude session.');
  assert.equal(calls, 0);
  await engine.tick();
  assert.equal(await dismiss(), undefined);
  write({ owner: null, phase: 'done' });
  await engine.tick();
  assert.equal(await dismiss(), undefined);
  write({ owner: null });
  await engine.tick();
  assert.ok(await dismiss());
  await engine.press(await engine.render('Pane'), 'dismiss');
  assert.equal(engine.toasts.at(-1), refusal);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8')).phase, 'codex-failed');
  await engine.press(await engine.render('Pane'), 'dismiss');
  await waitFor(() => engine.toasts.at(-1)?.includes('discarded (from codex-failed)'));
  assert.equal(engine.toasts.at(-1), `agent-duet ${sid}: audit discarded (from codex-failed).`);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledger, 'utf8')).discard.by, { claudeSession: 'claude-me' });
  await engine.tick();
  assert.equal(await dismiss(), undefined);
  const pane = await engine.render('Pane');
  assert.ok(!lines(pane).some((line) => line.startsWith(`${sid} · `)));
  await engine.press(pane, `task-${sid}`);
  assert.match(lines(await engine.render('Pane')).join('\n'), /🗑 discarded/);
  assert.doesNotMatch(lines(await engine.render('Pane')).join('\n'), /delegate interrupted/);
});

await test('old active build survives hundreds of newer ledgers in guard, Stop and context', async () => {
  const { engine, sid, write, stateHome } = await languageEngine({ language: 'en' });
  const build = buildOf('long-running');
  write({ ...build, phase: 'awaiting-review', updatedAt: ago(6 * 3600_000) });
  const file = path.join(stateHome, sid, 'state.json');
  fs.utimesSync(file, new Date(ago(6 * 3600_000)), new Date(ago(6 * 3600_000)));
  for (let i = 0; i < 200; i++) {
    const id = `20991231-235959-${i.toString(16).padStart(4, '0')}`;
    fs.mkdirSync(path.join(stateHome, id));
    fs.writeFileSync(path.join(stateHome, id, 'state.json'), JSON.stringify({
      id, cwd: repo, kind: 'audit', phase: 'done', updatedAt: ago(20 * 60_000),
    }));
  }
  assert.ok((await engine.bash(`git -C "${build.cwd}" push`)).deny?.includes(sid));
  assert.ok((await engine.stop()).block?.includes(sid));
  assert.ok((await engine.prompt('Progress?')).context?.join('').includes(sid));
  const before = engine.reads.length;
  await engine.tick();
  assert.equal(engine.reads.slice(before).filter((f) => f.endsWith('/state.json')).length, 0);
  write({ ...build, phase: 'awaiting-review', updatedAt: ago(13 * 3600_000) });
  await engine.tick();
  assert.equal((await engine.bash(`git -C "${build.cwd}" push`)).result, 'core reached');
  assert.equal((await engine.prompt('Progress?')).context, undefined);
});

await test('migrated build and ownerless review recognize both symlink spellings', async () => {
  const { engine, sid, write, stateHome } = await languageEngine({ language: 'en' });
  const alias = stateHome + '-legacy';
  fs.symlinkSync(stateHome, alias);
  const physical = path.join(stateHome, sid, 'worktree');
  const legacy = path.join(alias, sid, 'worktree');
  fs.mkdirSync(path.join(physical, 'sub'), { recursive: true });
  for (const [root, target] of [[legacy, physical], [physical, legacy]]) {
    write({ kind: 'build', cwd: root, subject: { repo, branch: 'codex-duet/old', worktree: root }, phase: 'awaiting-review' });
    engine.setCwd(path.join(target, 'sub'));
    await engine.tick();
    assert.ok((await engine.bash('git commit')).deny?.includes(sid));
    assert.ok((await engine.bash(`git -C "${target}" stash`)).deny?.includes(sid));
    assert.ok((await engine.bash(`mkdir -p "${target}/new"; git -C "${target}/new" push`)).deny?.includes(sid));
    assert.equal((await engine.bash(`git -C "${elsewhere}" push`)).result, 'core reached');
  }
  const link = path.join(stateHome, 'via-subdir');
  fs.symlinkSync(path.join(physical, 'sub'), link);
  assert.ok((await engine.bash(`git -C "${link}/.." push`)).deny?.includes(sid));
  write({ owner: null, cwd: legacy });
  await engine.tick();
  engine.setCwd(physical);
  await engine.bash(`${RUNNER} status --session ${sid}`);
  assert.ok((await engine.stop()).block?.includes(sid));
  assert.ok((await engine.prompt('Progress?')).context?.join('').includes(sid));
});

await test('each live Claude session imports its own pane choices once across a shared store', async () => {
  const env = { AGENT_DUET_HOME: path.join(tmp, 'two-panes') };
  const store = new Map();
  for (const sessionId of ['claude-a', 'claude-b']) {
    const choices = { [sessionId + ':C1']: 'claude' };
    const initialState = new Map([['codex-duet:focus', sessionId], ['codex-duet:choices', choices],
      ['codex-duet:expanded', { [sessionId]: true }]]);
    const args = { env, cwd: repo, initialState, sessionId, store };
    if (sessionId === 'claude-b') initialState.set('codex-duet:prefs', { sound: false });
    const engine = await boot(compiled, args);
    assert.equal(engine.atoms.get('agent-duet:focus'), sessionId);
    assert.deepEqual(engine.atoms.get('agent-duet:choices'), choices);
    assert.deepEqual(engine.atoms.get('agent-duet:expanded'), { [sessionId]: true });
    if (sessionId === 'claude-b') assert.equal(engine.atoms.get('agent-duet:prefs').sound, false);
    initialState.set('agent-duet:focus', '');
    initialState.set('agent-duet:choices', {});
    const reload = await boot(compiled, args);
    assert.equal(reload.atoms.get('agent-duet:focus'), '');
    assert.deepEqual(reload.atoms.get('agent-duet:choices'), {});
  }
});

await test('Stop refuses a live unrelated PID and a stale button without sending TERM', async () => {
  const { engine, sid, write, stateHome } = await languageEngine({ language: 'en' });
  const lock = path.join(stateHome, sid, 'lock');
  write({ phase: 'awaiting-codex', pending: { round: 2, startedAt: ago(1000) } });
  fs.writeFileSync(lock, String(process.pid)); // the test process is alive but owns no runner lock
  await engine.tick();
  const pane = await engine.render('Pane');
  const result = await engine.command('duet', 'stop');
  assert.doesNotMatch(result.text, /Stopping/);
  assert.match(result.text, /verify|belongs|ownership/i);
  fs.writeFileSync(lock, '0');
  if (nodes(pane).some((n) => n.props.key === 'stop')) await engine.press(pane, 'stop');
  assert.ok(!engine.procs.some((cmd) => cmd.startsWith('kill -TERM')));
});

await test('Stop selects the focused queued runner and revalidates the running pane button', async () => {
  const stateHome = path.join(tmp, 'stop-runners');
  const children = [];
  const pluginAlias = path.join(tmp, 'installed plugin');
  fs.symlinkSync(path.dirname(path.dirname(DUET)), pluginAlias);
  const env = { ...baseEnv, AGENT_DUET_HOME: stateHome, AGENT_DUET_MAX_PARALLEL: '1',
    AGENT_DUET_QUEUE_POLL_MS: '25', AGENT_DUET_KILL_GRACE_MS: '100', AGENT_DUET_TIMEOUT_MS: '15000',
    FAKE_CODEX_SCRIPT: path.join(tmp, 'stop-script.json'), FAKE_CODEX_STATE: path.join(tmp, 'stop-calls.json') };
  fs.writeFileSync(env.FAKE_CODEX_SCRIPT, JSON.stringify([{ hang: true, started: true }]));
  const records = () => fs.existsSync(stateHome) ? fs.readdirSync(stateHome).flatMap((id) => {
    try { return [JSON.parse(fs.readFileSync(path.join(stateHome, id, 'state.json'), 'utf8'))]; } catch { return []; }
  }) : [];
  const start = async (phase) => {
    const child = spawn(process.execPath, [path.join(pluginAlias, 'scripts', 'duet.mjs'), 'start', '--kind', 'code'], { cwd: repo, env, stdio: 'ignore' });
    children.push(child);
    await waitFor(() => records().some((s) => s.phase === phase), 4000);
    return records().find((s) => s.phase === phase).id;
  };
  try {
    const running = await start('awaiting-codex');
    const queued = await start('queued');
    const ledger = path.join(stateHome, running, 'state.json');
    const newest = new Date(Date.now() + 1000);
    fs.utimesSync(ledger, newest, newest);
    let duringStop;
    const engine = await boot(compiled, { env, cwd: repo, options: { language: 'en' }, stopChildren: children,
      onProcess: ([program]) => {
        if (program === 'ps' && duringStop) {
          duringStop();
          duringStop = undefined;
        }
      },
    });
    assert.equal(engine.atoms.get('agent-duet:view').id, running, 'the default differs from the row to cancel');
    const select = async (id) => engine.press(await engine.render('Pane'), `task-${id}`);
    await select(running);
    const runningPane = await engine.render('Pane');
    const previous = fs.readFileSync(ledger, 'utf8');
    const changed = JSON.parse(previous);
    changed.pending.startedAt = ago(60_000); // same PID and round number, different attempt
    fs.writeFileSync(ledger, JSON.stringify(changed));
    await engine.press(runningPane, 'stop');
    assert.match(engine.toasts.at(-1), /verify/);
    fs.writeFileSync(ledger, previous);
    // Even a real runner from the same project cannot be stopped using another session's lock.
    const queuedLock = path.join(stateHome, queued, 'lock');
    fs.writeFileSync(queuedLock, String(children[0].pid));
    const mixed = await boot(compiled, { env, cwd: repo, options: { language: 'en' }, stopChildren: children });
    await mixed.press(await mixed.render('Pane'), `task-${queued}`);
    assert.match((await mixed.command('duet', 'stop')).text, /verify/);
    fs.writeFileSync(queuedLock, String(children[1].pid));
    await select(queued);
    const stopped = await engine.command('duet', 'stop');
    assert.match(stopped.text, /Stopping queued round 1/);
    await waitFor(() => records().some((s) => s.id === queued && s.phase === 'codex-failed'));
    assert.ok(records().some((s) => s.id === running && s.phase === 'awaiting-codex'));
    const signals = () => engine.procs.filter((cmd) => cmd.startsWith('kill -TERM'));
    assert.deepEqual(signals(), [`kill -TERM ${children[1].pid}`]);
    await waitFor(() => children[1].exitCode !== null);
    fs.rmSync(path.join(stateHome, queued), { recursive: true });

    const lock = path.join(stateHome, running, 'lock');
    const pid = fs.readFileSync(lock, 'utf8');
    const times = fs.statSync(lock);
    fs.utimesSync(lock, times.atime, new Date(ago(60_000))); // a new process using an old lock's PID
    await engine.press(runningPane, 'stop');
    assert.match(engine.toasts.at(-1), /verify/);
    fs.utimesSync(lock, times.atime, times.mtime);

    const otherScripts = path.join(tmp, 'different plugin', 'scripts');
    fs.mkdirSync(otherScripts, { recursive: true });
    const otherRunner = path.join(otherScripts, 'duet.mjs');
    fs.writeFileSync(otherRunner, `import { openSync } from 'node:fs';
      openSync(process.argv[3], 'r+'); process.send('ready'); setInterval(() => {}, 1000);`);
    const other = spawn(process.execPath, [otherRunner, 'start', lock, DUET, 'retry', '--session', running],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(other);
    let ready = false;
    other.once('message', () => { ready = true; });
    await waitFor(() => ready); // holds a read/write FD on the same inode, without owning its lock
    fs.writeFileSync(lock, String(other.pid)); // stale pane, then a fresh view with an unrelated live PID
    await engine.press(runningPane, 'stop');
    assert.match(engine.toasts.at(-1), /verify/);
    const fresh = await boot(compiled, { env, cwd: repo, options: { language: 'en' }, stopChildren: children });
    assert.match((await fresh.command('duet', 'stop')).text, /verify/);
    assert.equal(other.signalCode, null);
    fs.writeFileSync(lock, pid);
    const foreign = await boot(compiled, { env, cwd: repo, options: { language: 'en' }, sessionId: 'claude-other', stopChildren: children });
    assert.match((await foreign.command('duet', 'stop')).text, /another Claude session/);
    assert.ok(!nodes(await foreign.render('Pane')).some((n) => n.props.key === 'stop'));
    duringStop = () => fs.writeFileSync(lock, String(other.pid));
    await engine.press(runningPane, 'stop');
    assert.match(engine.toasts.at(-1), /verify/);
    fs.writeFileSync(lock, pid);
    duringStop = () => fs.writeFileSync(ledger, JSON.stringify(changed));
    await engine.press(runningPane, 'stop');
    assert.match(engine.toasts.at(-1), /verify/);
    fs.writeFileSync(ledger, previous);
    duringStop = () => {
      // A running turn observes a model and rewrites its ledger while Stop checks its process.
      const state = JSON.parse(fs.readFileSync(ledger, 'utf8'));
      state.pending.codexModel = { model: 'observed-during-the-turn' };
      fs.writeFileSync(ledger, JSON.stringify(state));
    };
    await engine.press(runningPane, 'stop');
    assert.match(engine.toasts.at(-1), /Stopping round 1/);
    assert.equal(duringStop, undefined, 'the model update ran during the process check');
    assert.deepEqual(signals(), [`kill -TERM ${children[1].pid}`, `kill -TERM ${pid}`]);
    await waitFor(() => records().some((s) => s.id === running && s.phase === 'codex-failed'));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitFor(() => children.every((c) => c.exitCode !== null || c.signalCode !== null), 5000);
  }
});

for (const language of ['en', 'ru', 'zh']) {
  await test(`${language}: an issue-free escalation gives its reason and both request checks`, async () => {
    const { engine, write, sid, stateHome } = await languageEngine({ language });
    const reason = 'The reviewers disagree on the requested scope';
    const check = (status, notes) => ({ status, notes });
    write({ ...buildOf('scope'), phase: 'escalated', issues: {}, decision: { action: 'escalate', issues: [], reason },
      rounds: [{ n: 1, verdict: 'approve', author: { request_check: check('narrowed', 'CSV export is missing') },
        request_check: check('matches', 'CSV export is optional') }] });
    const second = '20991231-000001-abcd';
    fs.mkdirSync(path.join(stateHome, second));
    fs.writeFileSync(path.join(stateHome, second, 'state.json'), JSON.stringify({
      id: second, kind: 'code', cwd: repo, phase: 'awaiting-author', updatedAt: ago(1000),
    }));
    const newest = new Date(Date.now() + 1000);
    fs.utimesSync(path.join(stateHome, sid, 'state.json'), newest, newest);
    await engine.tick();
    assert.ok(engine.toasts.some((line) => line.includes(reason)));
    assert.ok(lines(await engine.render('AbovePrompt')).join('').includes(reason));
    const pane = await engine.render('Pane');
    assert.ok(nodes(pane).find((n) => n.props.key === `task-${sid}`).props.label.includes(reason));
    for (const note of ['CSV export is missing', 'CSV export is optional']) assert.ok(lines(pane).join('\n').includes(note));
    assert.ok(!nodes(pane).some((n) => n.props.key === 'send-decisions'));
  });
}

await test('build scoreboard separates owner rulings from reviewer concessions', async () => {
  const { engine, write } = await languageEngine({ language: 'en' });
  const disputed = { action: 'disputed', round: 1, note: 'as specified' };
  write({ ...buildOf('scores'), issues: {
    C1: { ...issue('C1', 'withdrawn'), author: disputed, ownerRuled: true },
    C2: { ...issue('C2', 'open'), author: disputed, ownerRuled: true },
    C3: { ...issue('C3', 'withdrawn'), author: disputed },
  } });
  await engine.tick();
  assert.ok(lines(await engine.render('Pane')).includes('Claude conceded: 1 · owner decisions: 2'));
});

await test('executed verification keeps an outstanding compound failure visible during the next turn', async () => {
  const { engine, write } = await languageEngine({ language: 'en' });
  write({ phase: 'awaiting-codex', pending: { round: 2, startedAt: ago(1000) }, rounds: [{
    n: 1, verification: { label: 'executed', gaps: [], checks: [{
      command: 'make unit && make smoke', outcome: 'failed', confirmation: 'confirmed',
      events: [{ exit_code: 0 }, { exit_code: 23 }],
    }] },
  }] });
  await engine.tick();
  assert.ok(lines(await engine.render('Pane')).includes('failed: make unit && make smoke (exit 23)'));
});

await test('Stop recognizes fullwidth questions and closing Markdown, quotes and brackets', async () => {
  const { engine, write } = await languageEngine({ language: 'zh' });
  write();
  await engine.tick();
  for (const message of ['要继续吗？', '**May I proceed?**', 'Вопрос «Продолжить?»', '(Retry?)', '“继续吗？”', '【继续吗？】']) {
    assert.equal((await engine.stop({ last_assistant_message: message })).block, undefined, message);
  }
  assert.ok((await engine.stop({ last_assistant_message: 'The output says “retry?”. I fixed it.' })).block);
});

const AGY_TEXT = {
  en: { thinking: '⏳ agy is thinking', writing: '⏳ agy is writing code', auditing: '⏳ agy is auditing',
    started: /agy started round 2/, queued: /queued for agy/, review: /agy finished round 1/,
    author: /agy, round 1: 2 open/, hold: /agy finished round 1\/10 and awaits review/,
    choice: 'agy is right', gaps: 'agy did not check: Browser not examined', defaults: 'model from agy config' },
  ru: { thinking: '⏳ agy думает', writing: '⏳ agy пишет код', auditing: '⏳ agy проводит аудит',
    started: /agy начал раунд 2/, queued: /в очереди к agy/, review: /agy закончил раунд 1/,
    author: /agy, раунд 1: открыто 2/, hold: /agy закончил раунд 1\/10 и ждёт ревью/,
    choice: 'Прав agy', gaps: 'agy не проверял: Browser not examined', defaults: 'модель — по конфигу agy' },
  zh: { thinking: '⏳ agy 正在思考', writing: '⏳ agy 正在编写代码', auditing: '⏳ agy 正在审计',
    started: /agy 已开始第 2 轮/, queued: /排队等待 agy/, review: /agy 已完成第 1 轮/,
    author: /agy 第 1 轮：2 个未解决问题/, hold: /agy 已完成第 1\/10 轮，等待审查/,
    choice: 'agy 是对的', gaps: 'agy 未检查：Browser not examined', defaults: '模型来自 agy 配置' },
};

for (const language of ['en', 'ru', 'zh']) {
  await test(`${language}: agy names the worker across pane, band, toast, decisions and loop context without Codex Fast`, async () => {
    const { engine, sid, write, stateHome } = await languageEngine({ language });
    const expected = AGY_TEXT[language];
    // A normalized agy event keeps the Codex event shape, but its shell command is plain.
    const codexModel = { model: 'gemini-stand-in', effort: null, fromConfig: ['model', 'tier'], tier: 'priority' };
    const pending = { round: 2, startedAt: ago(1000), codexModel };
    const build = { kind: 'build', subject: { repo, worktree: repo, branch: 'agent-duet/agy' } };
    const save = (fields = {}) => write({ engine: 'agy', ...fields });
    save({ phase: 'awaiting-codex', pending });
    fs.writeFileSync(path.join(stateHome, sid, 'lock'), String(process.pid));
    fs.writeFileSync(path.join(stateHome, sid, 'round-2.events.jsonl'), [
      ...ran('cmd', 'python3 -m unittest tests.smoke'),
      { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Checked `parser`.\n\n- ready' } },
    ].map((event) => JSON.stringify(event)).join('\n'));
    await engine.tick();
    let pane = lines(await engine.render('Pane')).join('\n');
    assert.ok(pane.includes(expected.thinking), pane);
    assert.match(pane, /agy: Checked `parser`\.\n\n- ready/);
    assert.match(pane, /gemini-stand-in/);
    assert.doesNotMatch(pane, /\bCodex\b|Fast|⚡/);
    assert.match(lines(await engine.render('AbovePrompt')).join('\n'), /^⏳ agy gemini-stand-in · r2\/10/);
    assert.ok(engine.toasts.some((text) => expected.started.test(text)), engine.toasts.join('\n'));
    assert.match((await footer(engine)).join('\n'), /Duet r2 ⏳/);
    assert.ok((await engine.prompt('Progress?')).context.join('\n').includes(expected.thinking));

    save({ phase: 'queued', pending: { ...pending, queuedAt: ago(1000) } });
    await engine.tick();
    for (const text of [lines(await engine.render('Pane')).join('\n'), lines(await engine.render('AbovePrompt')).join('\n'), engine.toasts.at(-1)]) {
      assert.match(text, /agy/);
      assert.doesNotMatch(text, /\bCodex\b/);
    }
    assert.match(lines(await engine.render('AbovePrompt')).join('\n'), expected.queued);
    assert.match((await footer(engine)).join('\n'), /Duet ⏸/);

    save();
    await engine.tick();
    assert.match(engine.toasts.at(-1), expected.author);
    await engine.press(await engine.render('Pane'), `fold-${sid}:C1`);
    assert.match(lines(await engine.render('Pane')).join('\n'), /agy: Body of C1/);

    save({ ...build, phase: 'awaiting-review' });
    await engine.tick();
    assert.match(engine.toasts.at(-1), expected.review);
    assert.match(lines(await engine.render('AbovePrompt')).join('\n'), /agy/);
    await engine.bash(`${RUNNER} status --session ${sid}`);
    assert.match((await engine.stop()).block, expected.hold);
    assert.match((await footer(engine)).join('\n'), /Duet r1 🔍/);

    save({ ...build, phase: 'awaiting-codex', pending });
    await engine.tick();
    assert.ok(lines(await engine.render('Pane')).join('\n').includes(expected.writing));
    // History remains keyed by "codex" even though the build author's display name is agy.
    const issues = { C1: issue('C1', 'open', 'high', { history: [{ by: 'codex', action: 'fixed' }] }), C2: issue('C2', 'open') };
    save({ ...build, phase: 'escalated', issues, decision: { action: 'escalate', reason: 'Owner decision', issues: ['C1', 'C2'] } });
    await engine.tick();
    let tree = await engine.render('Pane');
    assert.equal(nodes(tree).find((n) => n.props.key === 'pick-codex-C1')?.props.label, expected.choice);
    const score = { en: 'agy: fixed 1', ru: 'agy: исправил 1', zh: 'agy：修复 1' }[language];
    assert.ok(lines(tree).some((line) => line.startsWith(score)), lines(tree).join('\n'));
    await engine.press(tree, 'pick-codex-C1');
    await engine.press(await engine.render('Pane'), 'pick-claude-C2');
    await engine.press(await engine.render('Pane'), 'send-decisions');
    assert.match(engine.submitted.at(-1), /C1:.*agy.*status withdrawn, owner: true/);
    assert.doesNotMatch(engine.submitted.at(-1), /\bCodex\b/);
    assert.match((await footer(engine)).join('\n'), LANGUAGE_TEXT[language].footer);

    save({ phase: 'escalated', decision: { action: 'escalate', reason: 'Owner decision', issues: ['C1'] } });
    await engine.tick();
    await engine.press(await engine.render('Pane'), 'pick-codex-C1');
    await engine.press(await engine.render('Pane'), 'send-decisions');
    assert.match(engine.submitted.at(-1), /C1:.*agy.*fixed/);
    assert.doesNotMatch(engine.submitted.at(-1), /\bCodex\b/);

    save({ phase: 'done', rounds: [{ n: 1, codexModel, verification: {
      label: 'static-analysis-only', checks: [], gaps: ['Browser not examined'],
    } }] });
    await engine.tick();
    pane = lines(await engine.render('Pane')).join('\n');
    assert.ok(pane.includes(expected.gaps), pane);
    assert.match(pane, /gemini-stand-in/);
    assert.doesNotMatch(pane, /\bCodex\b|Fast|⚡/);

    save({ kind: 'audit', subject: { title: 'Audit sample' }, phase: 'awaiting-codex', pending: { round: 2, startedAt: ago(1000) } });
    await engine.tick();
    pane = lines(await engine.render('Pane')).join('\n');
    assert.ok(pane.includes(expected.auditing), pane);
    assert.ok(pane.includes(expected.defaults), pane);
    assert.match((await engine.prompt('Audit progress?')).context.join('\n'), /agy/);
    assert.doesNotMatch([pane, ...engine.toasts].join('\n'), /\bCodex\b|Fast|⚡/);
    assert.ok(!engine.procs.some((command) => /^(?:agy|claude|gh|security)\b/.test(command)), 'the stand-in executes no agent or authentication command');
  });
}

for (const [language, modelLine] of [
  ['en', 'Model: gemini-stand-in (from config) · high'],
  ['ru', 'Модель: gemini-stand-in (из конфига) · high'],
  ['zh', '模型：gemini-stand-in（来自配置） · high'],
]) {
  await test(`${language}: agy displays explicit effort in current and recorded models while hiding only Fast`, async () => {
    const { engine, sid, write, stateHome } = await languageEngine({ language });
    const codexModel = { model: 'gemini-stand-in', effort: 'high', fromConfig: ['model', 'tier'], tier: 'priority' };
    write({ engine: 'agy', phase: 'awaiting-codex', pending: { round: 2, startedAt: ago(1000), codexModel } });
    fs.writeFileSync(path.join(stateHome, sid, 'lock'), String(process.pid));
    await engine.tick();
    let pane = lines(await engine.render('Pane')).join('\n');
    let band = lines(await engine.render('AbovePrompt')).join('\n');
    assert.ok(pane.includes(modelLine), pane);
    assert.match(band, /^⏳ agy gemini-stand-in\/high · r2\/10/);
    assert.doesNotMatch(`${pane}\n${band}`, /Fast|⚡/);
    write({ engine: 'agy', phase: 'done', rounds: [{ n: 1, codexModel, verdict: 'approve' }] });
    await engine.tick();
    pane = lines(await engine.render('Pane')).join('\n');
    assert.ok(pane.includes(modelLine), pane);
    assert.doesNotMatch(pane, /Fast|⚡/);
    // An explicit effort remains visible even when the default model has not been recorded.
    write({ engine: 'agy', phase: 'awaiting-codex', pending: {
      round: 2, startedAt: ago(1000), codexModel: { ...codexModel, model: null },
    } });
    await engine.tick();
    pane = lines(await engine.render('Pane')).join('\n');
    band = lines(await engine.render('AbovePrompt')).join('\n');
    assert.ok(pane.includes(`${AGY_TEXT[language].defaults} · high`), pane);
    assert.match(band, /^⏳ agy high · r2\/10/);
  });
}

for (const [language, modelLine] of [
  ['en', 'Model: gemini-3.8-flash-low · family gemini-3.8-flash (from config) · low'],
  ['ru', 'Модель: gemini-3.8-flash-low · семейство gemini-3.8-flash (из конфига) · low'],
  ['zh', '模型：gemini-3.8-flash-low · 系列 gemini-3.8-flash（来自配置） · low'],
]) {
  await test(`${language}: agy effective slug distinguishes config family from explicit level`, async () => {
    const { engine, sid, write, stateHome } = await languageEngine({ language });
    const codexModel = { model: 'gemini-3.8-flash-low', family: 'gemini-3.8-flash', effort: 'low', fromConfig: ['family'] };
    write({ engine: 'agy', phase: 'awaiting-codex', pending: { round: 2, startedAt: ago(1000), codexModel } });
    fs.writeFileSync(path.join(stateHome, sid, 'lock'), String(process.pid));
    await engine.tick();
    let pane = lines(await engine.render('Pane')).join('\n');
    assert.ok(pane.includes(modelLine), pane);
    assert.match(lines(await engine.render('AbovePrompt')).join('\n'), /^⏳ agy gemini-3\.8-flash-low\/low/);
    write({ engine: 'agy', phase: 'done', rounds: [{ n: 1, codexModel, verdict: 'approve' }] });
    await engine.tick();
    pane = lines(await engine.render('Pane')).join('\n');
    assert.ok(pane.includes(modelLine), pane);
  });
}

for (const [language, freshLog] of [
  ['en', /agy log updated 2\d+s ago/],
  ['ru', /журнал agy обновлён 2\d+ с назад/],
  ['zh', /agy 日志更新于 2\d+ 秒前/],
]) {
  await test(`${language}: agy freshness uses the newest conversation DB or WAL mtime and the saved conversation id`, async () => {
    const agyHome = path.join(tmp, `agy-log-${language}`);
    const logEnv = language === 'en' ? { CODEX_DUET_AGY_HOME: agyHome }
      : { AGENT_DUET_AGY_HOME: agyHome, CODEX_DUET_AGY_HOME: path.join(tmp, 'unused-legacy-agy-home') };
    const { engine, sid, write, stateHome } = await languageEngine({ language }, logEnv);
    const threadId = `conversation-${language}`;
    const db = path.join(agyHome, 'conversations', `${threadId}.db`);
    const wal = `${db}-wal`;
    fs.mkdirSync(path.dirname(db), { recursive: true });
    // These are intentionally opaque bytes: the pane needs only stat, never the database contents.
    fs.writeFileSync(db, '\0sqlite stand-in');
    fs.writeFileSync(wal, '\0wal stand-in');
    write({ engine: 'agy', phase: 'awaiting-codex', codex: { threadId }, pending: { round: 2, startedAt: ago(20 * MIN) } });
    fs.writeFileSync(path.join(stateHome, sid, 'lock'), String(process.pid));
    const events = path.join(stateHome, sid, 'round-2.events.jsonl');
    fs.writeFileSync(events, JSON.stringify({ type: 'item.completed', _at: ago(16 * MIN), item: { id: 'm', type: 'agent_message', text: 'Earlier words' } }));
    fs.utimesSync(events, past(15 * MIN), past(15 * MIN));
    fs.utimesSync(db, past(6 * MIN), past(6 * MIN));
    fs.utimesSync(wal, past(20_000), past(20_000));
    await engine.tick();
    let pane = lines(await engine.render('Pane')).join('\n');
    assert.match(pane, freshLog, 'recent WAL keeps a quiet conversation fresh');
    assert.doesNotMatch(pane, /Codex/);
    // A newer DB wins too, and a missing sidecar must not hide the DB's freshness.
    fs.utimesSync(db, past(20_000), past(20_000));
    fs.utimesSync(wal, past(8 * MIN), past(8 * MIN));
    await engine.tick();
    assert.match(lines(await engine.render('Pane')).join('\n'), freshLog);
    fs.rmSync(wal);
    await engine.tick();
    assert.match(lines(await engine.render('Pane')).join('\n'), freshLog);
    // A missing DB must not hide a surviving WAL, and absence of both is a quiet fallback.
    fs.writeFileSync(wal, '\0wal stand-in');
    fs.utimesSync(wal, past(20_000), past(20_000));
    fs.rmSync(db);
    await engine.tick();
    assert.match(lines(await engine.render('Pane')).join('\n'), freshLog);
    fs.rmSync(wal);
    await engine.tick();
    pane = lines(await engine.render('Pane')).join('\n');
    assert.doesNotMatch(pane, freshLog);
    assert.match(pane, /Earlier words/);
  });
}

await test('agy freshness defaults to HOME/.gemini/antigravity-cli and can use the normalized thread event', async () => {
  const { engine, sid, write, stateHome } = await languageEngine({ language: 'en' });
  const threadId = 'default-home-conversation';
  // Only the engine's stat response is faked; no file is created in the actual home directory.
  engine.setFile(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${threadId}.db`), true);
  write({ engine: 'agy', phase: 'awaiting-codex', pending: { round: 2, startedAt: ago(1000) } });
  fs.writeFileSync(path.join(stateHome, sid, 'lock'), String(process.pid));
  fs.writeFileSync(path.join(stateHome, sid, 'round-2.events.jsonl'), JSON.stringify({ type: 'thread.started', thread_id: threadId }));
  await engine.tick();
  assert.match(lines(await engine.render('Pane')).join('\n'), /agy log updated/);
});

await test('agy freshness uses the pending conversation before normalized events arrive', async () => {
  const agyHome = path.join(tmp, 'agy-pending-log');
  const { engine, sid, write, stateHome } = await languageEngine({ language: 'en' }, { AGENT_DUET_AGY_HOME: agyHome });
  const threadId = 'pending-conversation';
  const wal = path.join(agyHome, 'conversations', `${threadId}.db-wal`);
  fs.mkdirSync(path.dirname(wal), { recursive: true });
  fs.writeFileSync(wal, '\0wal stand-in');
  fs.utimesSync(wal, past(20_000), past(20_000));
  write({ engine: 'agy', phase: 'awaiting-codex', codex: { threadId: 'old-conversation' },
    pending: { round: 2, threadId, startedAt: ago(1000) } });
  fs.writeFileSync(path.join(stateHome, sid, 'lock'), String(process.pid));
  await engine.tick();
  assert.match(lines(await engine.render('Pane')).join('\n'), /agy log updated 2\d+s ago/);
});

for (const [language, warning, changes] of [
  ['en', '⚠ agy read-only violation:', ['added', 'changed', 'removed']],
  ['ru', '⚠ agy нарушил режим только чтения:', ['добавлен', 'изменён', 'удалён']],
  ['zh', '⚠ agy 违反只读模式：', ['已添加', '已更改', '已删除']],
]) {
  await test(`${language}: read-only violations show each changed path as a persistent warning, with round-only state compatibility`, async () => {
    const { engine, write } = await languageEngine({ language });
    const violations = [
      { path: 'docs/new file.md', change: 'added', round: 1 },
      { path: 'src/changed.ts', change: 'changed', round: 2 },
      { path: 'old/deleted.ts', change: 'removed', round: 2 },
    ];
    const rounds = [{ n: 1, readOnlyViolations: [violations[0]] }, { n: 2, readOnlyViolations: violations.slice(1) }];
    write({ engine: 'agy', phase: 'codex-failed', round: 1, pending: { round: 2, error: 'Read-only tree changed' },
      rounds, readOnlyViolations: violations });
    await engine.tick();
    const warnings = (tree) => nodes(tree).filter((node) => node.type === 'Text'
      && lines(node).some((line) => line.startsWith(warning)));
    let shown = warnings(await engine.render('Pane'));
    assert.equal(shown.length, 3, 'cumulative and per-round records are not duplicated');
    for (const [index, node] of shown.entries()) {
      assert.ok(lines(node)[0].startsWith(`${warning}${language === 'zh' ? '' : ' '}${changes[index]} `), lines(node)[0]);
      assert.ok(lines(node)[0].endsWith(violations[index].path), lines(node)[0]);
      assert.equal(node.props.color, 'yellow');
      assert.equal(node.props.wrap, 'wrap');
    }
    // The warning remains visible on a later successful round, including ledgers with only round records.
    write({ engine: 'agy', phase: 'done', round: 3, rounds: [...rounds, { n: 3, verdict: 'approve' }] });
    await engine.tick();
    shown = warnings(await engine.render('Pane'));
    assert.equal(shown.length, 3);
    assert.ok(shown.every((node, index) => lines(node)[0].endsWith(violations[index].path)));
    write({ engine: 'agy', phase: 'done' });
    await engine.tick();
    assert.equal(warnings(await engine.render('Pane')).length, 0, 'clean sessions have no warning');
  });
}

for (const [language, missing, other] of [
  ['en', 'quote missing', 'quote in another file'],
  ['ru', 'цитата не найдена', 'цитата в другом файле'],
  ['zh', '未找到引文', '引文在其他文件中'],
]) {
  await test(`${language}: the board marks only open MISSING and other_file citations`, async () => {
    const { engine, write } = await languageEngine({ language });
    const citations = ['MISSING', 'other_file:elsewhere.js', 'ok', 'moved:88', 'unchecked', null, 'MISSING', 'other_file:elsewhere.js', 'ok'];
    write({ issues: Object.fromEntries(citations.map((mark, n) => {
      const iid = `C${n + 1}`;
      return [iid, { ...issue(iid, n === 7 ? 'withdrawn' : n >= 6 ? 'resolved' : 'open'), ...(mark ? { quoteCheck: { mark, round: 1 } } : {}) }];
    })) });
    await engine.tick();
    await engine.press(await engine.render('Pane'), 'fold-closed');
    const pane = lines(await engine.render('Pane'));
    assert.ok(pane.includes(`Issue C1 · ${missing}`), pane.join('\n'));
    assert.ok(pane.includes(`Issue C2 · ${other}`), pane.join('\n'));
    for (const iid of ['C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']) assert.ok(pane.includes(`Issue ${iid}`), pane.join('\n'));
    assert.equal(pane.filter((line) => line.includes(missing) || line.includes(other)).length, 2);
  });
}

for (const [language, done, labels, skipped, failed, gaps] of [
  ['en', '✅ done · verification: ', ['executed', 'partial', 'static-analysis-only', 'unknown'], 'skipped', 'failed', 'Codex did not check: '],
  ['ru', '✅ готово · проверка: ', ['выполнена', 'частичная', 'только статический анализ', 'неизвестно'], 'пропущено', 'упало', 'Codex не проверял: '],
  ['zh', '✅ 已完成 · 验证：', ['已执行', '部分执行', '仅静态分析', '未知'], '已跳过', '失败', 'Codex 未检查：'],
]) {
  await test(`${language}: DONE in pane and band carries the last Codex verification, including after post-approval`, async () => {
    const { engine, write } = await languageEngine({ language });
    for (const [i, label] of ['executed', 'partial', 'static-analysis-only', 'unknown'].entries()) {
      const receipt = {
        label,
        checks: label === 'executed' ? [{ command: 'node --test', outcome: 'passed', note: '', confirmation: 'confirmed' }] : [
          { command: 'npm run integration', outcome: 'skipped', note: 'Missing credentials', confirmation: 'skipped' },
          ...(label === 'partial' ? [{ command: 'node repro.mjs', outcome: 'failed', note: 'Reproduced crash', confirmation: 'confirmed', event: { exit_code: 1, status: 'failed' } }] : []),
        ],
        gaps: label === 'executed' ? [] : ['Browser path not inspected'],
      };
      write({
        ...buildOf('receipt'), phase: 'done', round: 2,
        rounds: [
          { n: 1, verdict: 'approve', ...(label === 'unknown' ? {} : { verification: receipt }) },
          { n: 2, kind: 'post-approval', verdict: 'approve' },
        ],
        decision: { action: 'done', reason: 'Approved', issues: [] }, issues: {},
      });
      await engine.tick();
      const pane = lines(await engine.render('Pane'));
      const band = lines(await engine.render('AbovePrompt'));
      assert.ok(pane.includes(`${done}${labels[i]}`), pane.join('\n'));
      assert.ok(band[0].includes(`${done}${labels[i]}`), band.join('\n'));
      if (label === 'partial' || label === 'static-analysis-only') {
        assert.ok(pane.some((line) => line.includes(`${skipped}: npm run integration — Missing credentials`)), pane.join('\n'));
        if (label === 'partial') assert.ok(pane.some((line) => line.includes(`${failed}: node repro.mjs (exit 1) — Reproduced crash`)), pane.join('\n'));
        assert.ok(pane.some((line) => line.endsWith(`${gaps}Browser path not inspected`)), pane.join('\n'));
      }
    }
    write({ phase: 'done', updatedAt: ago(11 * 60_000) });
    await engine.tick();
    assert.equal(await engine.render('AbovePrompt'), BELOW, 'an old DONE does not occupy the band');
  });
}

await test('ru: a check fed a script on a here-document is named by what it runs, never by its whole source', async () => {
  const { engine, write } = await languageEngine({ language: 'ru' });
  const script = "python3 - <<'PY'\nfrom pathlib import Path\nassert Path('a.txt').read_text() == 'x', 'differs'\nprint('PASS')\nPY";
  write({
    ...buildOf('heredoc'), phase: 'done', round: 1,
    rounds: [{ n: 1, verdict: 'approve', verification: { label: 'partial', gaps: ['Browser path not inspected'], checks: [
      { command: script, outcome: 'passed', note: '', confirmation: 'unconfirmed', event: { command: script, exit_code: 0, status: 'completed' } },
      { command: `npm run e2e -- ${'--grep slow '.repeat(12)}`, outcome: 'skipped', note: 'No browser', confirmation: 'skipped' },
    ] } }],
    decision: { action: 'done', reason: 'Approved', issues: [] }, issues: {},
  });
  await engine.tick();
  const pane = lines(await engine.render('Pane'));
  assert.ok(pane.some((line) => line.startsWith('не подтверждено: запускает скрипт Python (exit 0)')), pane.join('\n'));
  assert.ok(pane.some((line) => line.includes('пропущено: npm run e2e')), pane.join('\n'));
  assert.ok(!pane.some((line) => line.includes('read_text') || line.includes('--grep slow '.repeat(8))), pane.join('\n'));
});

await test('ru: what Codex did not check is a plain note; only a check that failed or lacks evidence draws attention', async () => {
  const { engine, write } = await languageEngine({ language: 'ru' });
  const passed = (command) => ({ command, outcome: 'passed', note: '', confirmation: 'confirmed', event: { command, exit_code: 0, status: 'completed' } });
  const failed = (command) => ({ command, outcome: 'failed', note: 'broke', confirmation: 'confirmed', event: { command, exit_code: 1, status: 'failed' } });
  const done = (checks, gaps) => write({
    ...buildOf('note'), phase: 'done', round: 1,
    rounds: [{ n: 1, verdict: 'approve', verification: { label: 'partial', checks, gaps } }],
    decision: { action: 'done', reason: 'Approved', issues: [] }, issues: {},
  });
  const receipt = async () => {
    await engine.tick();
    const all = nodes(await engine.render('Pane')).filter((n) => n.type === 'Text').map((n) => ({ text: n.children.join(''), props: n.props }));
    return { yellow: all.filter((n) => n.props.color === 'yellow').map((n) => n.text), notes: all.filter((n) => n.text.startsWith('Подтверждено')) };
  };

  done(['make check', 'node a.mjs', 'node b.mjs', 'node c.mjs'].map(passed), ['Graylog not queried', 'Ranking not reviewed']);
  let { yellow, notes } = await receipt();
  assert.deepEqual(yellow, []);
  assert.deepEqual(notes.map((n) => n.text), ['Подтверждено 4 из 4 · Codex не проверял: Graylog not queried; Ranking not reviewed']);
  assert.equal(notes[0].props.dimColor, true);

  // a failure the rerun put right is history; the count leaves it out
  done([failed('node verify.mjs'), passed('node verify.mjs'), passed('make check')], ['Graylog not queried']);
  ({ yellow, notes } = await receipt());
  assert.deepEqual(yellow, []);
  assert.deepEqual(notes.map((n) => n.text), ['Подтверждено 2 из 2 · Codex не проверял: Graylog not queried']);

  // a failure nothing put right, and a claim the log does not back, do draw attention
  done([failed('node verify.mjs'), { command: 'npm test', outcome: 'passed', note: '', confirmation: 'unconfirmed' }, passed('make check')], []);
  ({ yellow, notes } = await receipt());
  assert.deepEqual(yellow, ['упало: node verify.mjs (exit 1) — broke; не подтверждено: npm test']);
  assert.deepEqual(notes.map((n) => n.text), ['Подтверждено 1 из 3']);
});

await test('the default option draws English with an English locale and with no locale available', async () => {
  for (const env of [{ LANG: 'en_US.UTF-8' }, {}]) {
    const { engine } = await languageEngine(undefined, env);
    const pane = lines(await engine.render('Pane')).join('\n');
    assert.match(pane, LANGUAGE_TEXT.en.empty);
    assert.doesNotMatch(pane, /[А-Яа-яЁё\u3400-\u9fff]/);
  }
});

await test('auto uses the first nonempty LC_ALL, LC_MESSAGES or LANG', async () => {
  const cases = [
    [{ LANG: 'ru_RU.UTF-8' }, 'ru'],
    [{ LANG: 'zh_CN.UTF-8' }, 'zh'],
    [{ LC_ALL: 'en_US.UTF-8', LANG: 'ru_RU.UTF-8' }, 'en'],
    [{ LC_ALL: 'ru_RU.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }, 'ru'],
    [{ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'ru_RU.UTF-8' }, 'zh'],
    [{ LC_ALL: '', LC_MESSAGES: '', LANG: 'zh_CN.UTF-8' }, 'zh'],
    [{ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }, 'en'],
    [{ LANG: 'de_DE.UTF-8' }, 'en'],
  ];
  for (const [env, language] of cases) {
    const { engine } = await languageEngine({ language: 'auto' }, env);
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT[language].empty, JSON.stringify(env));
  }
});

const appleLanguages = (stdout, exitCode = 0) => ({ exitCode, stdout, stderr: '' });
await test('auto falls back to the first macOS preferred language when locale variables are empty', async () => {
  const cases = [
    ['(\n    "ru-CY",\n    "el-CY",\n    "en-CY"\n)\n', 'ru'],
    ['(\n    "zh-Hans-CN",\n    en\n)', 'zh'],
    ['("en-US", "ru-CY")', 'en'],
    ['(en)', 'en'],
    ['(ru, en)', 'ru'],
    ['(zh, en)', 'zh'],
    ['("el-CY", "ru-CY")', 'en'],
  ];
  for (const [stdout, language] of cases) {
    const { engine } = await languageEngine(undefined, { LC_ALL: '', LC_MESSAGES: '', LANG: '' }, appleLanguages(stdout));
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT[language].empty, stdout);
    assert.deepEqual(engine.procs.filter((command) => command.startsWith('defaults')), ['defaults read -g AppleLanguages']);
  }
});

await test('unavailable, failed, empty or malformed macOS preferences fall back to English', async () => {
  const cases = [
    new Error('spawn defaults ENOENT'),
    appleLanguages('(ru)', 1),
    ...['', '()', '( )', 'ru-CY', '("ru-CY)', '("ru-CY"', '("ru-CY", ???)', '("ru-CY",)'].map((text) => appleLanguages(text)),
  ];
  for (const result of cases) {
    const { engine } = await languageEngine({ language: 'auto' }, {}, result);
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT.en.empty);
  }
});

await test('environment variables and explicit settings win without reading macOS preferences', async () => {
  const cases = [
    [undefined, { LANG: 'en_US.UTF-8' }, 'en'],
    [{ language: 'auto' }, { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }, 'en'],
    [{ language: 'auto' }, { LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }, 'zh'],
    ...['en', 'ru', 'zh'].map((language) => [{ language }, {}, language]),
  ];
  for (const [options, env, language] of cases) {
    const { engine } = await languageEngine(options, env, appleLanguages('("ru-CY")'));
    assert.match(lines(await engine.render('Pane')).join('\n'), LANGUAGE_TEXT[language].empty);
    assert.ok(!engine.procs.some((command) => command.startsWith('defaults')), JSON.stringify({ options, env }));
  }
});

for (const language of ['auto', 'en', 'ru', 'zh']) {
  await test(`${language}: pane, band, footer, toast, context, Stop hold, guard and decisions use the chosen language`, async () => {
    // An explicit option must override the locale, including an English option over a Russian locale.
    const options = language === 'auto' ? undefined : { language };
    const env = language === 'auto' ? { LANG: 'en_US.UTF-8' } : { LC_ALL: language === 'ru' ? 'zh_CN.UTF-8' : 'ru_RU.UTF-8' };
    const { engine, sid, write } = await languageEngine(options, env);
    const expected = LANGUAGE_TEXT[language === 'auto' ? 'en' : language];
    assert.match(lines(await engine.render('Pane')).join('\n'), expected.empty);
    write();
    await engine.tick();
    const pane = lines(await engine.render('Pane')).join('\n');
    const band = lines(await engine.render('AbovePrompt')).join('\n');
    assert.match(pane, expected.pane);
    assert.match(band, expected.band);
    assert.ok(engine.toasts.some((text) => expected.toast.test(text)), engine.toasts.join('\n'));
    const context = (await engine.prompt('How is the review going?')).context.join('\n');
    assert.match(context, expected.context);
    assert.ok(context.includes(`status --session ${sid}`), context);
    await engine.bash(`${RUNNER} status --session ${sid}`);
    const hold = (await engine.stop()).block ?? '';
    assert.ok(hold.startsWith(`agent-duet ${sid}:`), hold);
    assert.match(hold, expected.hold);
    const deny = (await engine.bash('git commit -m test')).deny ?? '';
    assert.match(deny, expected.deny);
    write({ phase: 'escalated', decision: { action: 'escalate', reason: 'Owner decision needed', issues: ['C1'] } });
    await engine.tick();
    const footerText = (await footer(engine)).join('\n');
    assert.match(footerText, expected.footer);
    await engine.press(await engine.render('Pane'), 'pick-codex-C1');
    await engine.press(await engine.render('Pane'), 'send-decisions');
    const submitted = engine.submitted.at(-1);
    assert.ok(submitted.startsWith(`agent-duet ${sid}:`), submitted);
    assert.match(submitted, expected.decisions);
    assert.match(submitted, expected.codex);
    // Build reverses the roles: siding with Claude keeps the issue open with an owner ruling;
    // siding with Codex withdraws it. The structured flag stays stable in every language.
    write({
      kind: 'build', subject: { repo, worktree: repo, branch: 'agent-duet/localized' },
      phase: 'escalated', decision: { action: 'escalate', reason: 'Owner decision needed', issues: ['C1', 'C2'] },
    });
    await engine.tick();
    await engine.press(await engine.render('Pane'), 'pick-claude-C1');
    await engine.press(await engine.render('Pane'), 'pick-codex-C2');
    await engine.press(await engine.render('Pane'), 'send-decisions');
    const buildSubmitted = engine.submitted.at(-1);
    assert.ok(buildSubmitted.startsWith(`agent-duet ${sid}:`), buildSubmitted);
    assert.match(buildSubmitted, expected.decisions);
    assert.match(buildSubmitted, expected.ownerMarker);
    assert.match(buildSubmitted, /C1:.*owner: true/);
    assert.match(buildSubmitted, /C2:.*status withdrawn, owner: true/);
    if (language === 'en' || language === 'auto') {
      const commands = await Promise.all(['', 'status', 'sound on', 'stop', 'help'].map((args) => engine.command('duet', args)));
      assert.doesNotMatch([
        pane, band, context, hold, deny, footerText, submitted, buildSubmitted, ...engine.toasts, ...engine.statuses,
        ...engine.suggested, ...commands.map((reply) => reply.text ?? ''),
      ].join('\n'), /[А-Яа-яЁё\u3400-\u9fff]/, 'all mod-authored text is English');
    }
  });
}

const localeTables = {};
await test('locale tables have exactly the English keys and matching value types', async () => {
  const tables = localeTables;
  for (const language of ['en', 'ru', 'zh']) {
    const dir = path.join(tmp, `locale-${language}`);
    fs.mkdirSync(dir);
    const file = compile(path.join(HERE, '..', 'hooks', 'locales', `${language}.ts`), dir);
    const module = await import(pathToFileURL(file).href);
    tables[language] = module[language];
    assert.equal(typeof tables[language], 'object', `${language} exports its locale table`);
  }
  const contract = (table) => Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value && typeof value === 'object' ? contract(value) : typeof value]));
  assert.deepEqual(contract(tables.ru), contract(tables.en));
  assert.deepEqual(contract(tables.zh), contract(tables.en));
});

await test('English uses singular and plural, Russian one/few/many, and Chinese unchanged nouns', async () => {
  const { en, ru, zh } = localeTables;
  for (const [n, issueWord, roundWord] of [
    [0, 'замечаний', 'раундов'], [1, 'замечание', 'раунд'], [2, 'замечания', 'раунда'],
    [5, 'замечаний', 'раундов'], [11, 'замечаний', 'раундов'], [21, 'замечание', 'раунд'],
  ]) {
    assert.ok(en.bandAuthor(1, 10, n).endsWith(`${n} ${n === 1 ? 'issue' : 'issues'}`));
    assert.equal(en.toastReviewDone('', n), `agent-duet: review complete in ${n} ${n === 1 ? 'round' : 'rounds'} ✓`);
    assert.ok(ru.bandAuthor(1, 10, n).endsWith(`${n} ${issueWord}`));
    assert.equal(ru.toastReviewDone('', n), `agent-duet: ревью завершено за ${n} ${roundWord} ✓`);
    assert.ok(zh.bandAuthor(1, 10, n).endsWith(`${n} 个问题`));
    assert.equal(zh.toastReviewDone('', n), `agent-duet: 审查完成，共 ${n} 轮 ✓`);
  }
});

await test('durations and the age of Codex messages use each language’s units and phrasing', async () => {
  const expected = {
    en: ['2s', '6 min', '1h 5m', ', 2s ago', ', over 6 min ago'],
    ru: ['2 с', '6 мин', '1ч 5м', ', 2 с назад', ', больше 6 мин назад'],
    zh: ['2 秒', '6 分钟', '1 小时 5 分钟', '，2 秒前', '，超过 6 分钟前'],
  };
  for (const language of ['en', 'ru', 'zh']) {
    const locale = localeTables[language];
    assert.deepEqual([
      locale.seconds(2), locale.minutes(6), locale.hoursMinutes(1, 5),
      locale.wordsAgo(locale.seconds(2)), locale.wordsOlder(locale.minutes(6)),
    ], expected[language]);
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} mod tests passed`);
