// Verification is information for the owner, separate from the stop policy.
import fs from 'node:fs';
import { createInterface } from 'node:readline';

export function verificationClaims(raw) {
  // Older replies have only a free-text tests claim, or no verification fields at all.
  if (!Object.hasOwn(raw, 'checks')) return {};
  const checks = [];
  const gaps = [];
  if (Array.isArray(raw.checks)) {
    for (const check of raw.checks) {
      if (check && typeof check.command === 'string' && check.command.trim()
        && ['passed', 'failed', 'skipped'].includes(check.outcome) && typeof check.note === 'string') {
        checks.push({ command: check.command, outcome: check.outcome, note: check.note.trim() });
      }
    }
    const dropped = raw.checks.length - checks.length;
    if (dropped) gaps.push(`(${dropped} malformed check${dropped === 1 ? '' : 's'} dropped)`);
  } else gaps.push('(malformed checks ignored: expected an array)');
  if (Array.isArray(raw.gaps)) {
    gaps.push(...raw.gaps.filter((gap) => typeof gap === 'string').map((gap) => gap.trim()).filter(Boolean));
    const dropped = raw.gaps.filter((gap) => typeof gap !== 'string').length;
    if (dropped) gaps.push(`(${dropped} malformed gap${dropped === 1 ? '' : 's'} dropped)`);
  } else if (raw.gaps !== undefined) {
    gaps.push('(malformed gaps ignored: expected an array)');
  }
  return { checks, gaps };
}

// Decode one literal shell word. Expansions, operators and extra arguments are not a literal payload.
function literalWord(word) {
  if (!word) return null;
  let quote = '';
  let decoded = '';
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === '\\' && quote !== "'") {
      const next = word[i + 1];
      if (next === undefined) return null;
      if (!quote || '\\"$`\n'.includes(next)) {
        if (next !== '\n') decoded += next;
        i += 1;
      } else decoded += c;
    } else if (c === quote) quote = '';
    else if (!quote && (c === "'" || c === '"')) quote = c;
    else if (quote !== "'" && (c === '$' || c === '`')) return null;
    else if (!quote && /[ \t\n]/.test(c)) return /^[ \t\n]*$/.test(word.slice(i)) ? decoded : null;
    else if (!quote && /[;&|<>(){}*?\[\]~#]/.test(c)) return null;
    else decoded += c;
  }
  return quote ? null : decoded;
}

// The harness serializes a shell, its options and one script argument into the command event.
function wrappedScript(command) {
  const match = /^[ \t\n]*(?:\/(?:[\w.+-]+\/)*)?(?:sh|bash|zsh|dash|ksh|mksh)[ \t]+(?:-c|-lc|-cl|(?:-l|--login)[ \t]+-c)[ \t]+([\s\S]+)$/.exec(command);
  return match && literalWord(match[1]);
}

const ASSIGNMENT = /^[A-Za-z_]\w*=/;

// A remaining inline shell, eval or shell control flow can supply an exit which hides the check.
// A shell running a named script is an ordinary check, like a Python or Node script.
function hidesExit(words, inlineInput) {
  let i = 0;
  while (i < words.length) {
    const word = words[i++];
    if (ASSIGNMENT.test(word)) continue;
    const literal = literalWord(word);
    if (ASSIGNMENT.test(literal)) continue; // env accepts quoted NAME=value arguments too
    const name = literal?.split('/').at(-1);
    if (!name) return true;
    if (['env', 'command', 'builtin', 'time', 'nohup'].includes(name)) {
      // GNU env accepts options after NAME=value too (env A=1 -S '…'): look past the assignments.
      while (i < words.length && ASSIGNMENT.test(literalWord(words[i]) ?? '')) i++;
      const option = literalWord(words[i]);
      if (option === '--') i++;
      else if (option?.startsWith('-')) return true;
      continue;
    }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish'].includes(name)) {
      // Plain -e/-u/-x and their +e/+u/+x opposites only; any other option (+o, -o, -c …) may run inline input.
      while (/^[-+][eux]+$/.test(words[i])) i++;
      if (words[i] === '--') i++;
      const script = literalWord(words[i]);
      return inlineInput || !script || /^[-+]/.test(script);
    }
    return ['eval', '.', 'source', 'exec', 'exit', 'return', '!', 'if', 'while', 'until', 'for', 'case'].includes(name);
  }
  return true;
}

// Split only top-level shell operators, not quoted arguments or substitutions. Unsupported
// syntax keeps an exact-match key, but cannot prove a verification's outcome. A here-document
// body (`python3 - <<'PY' … PY`) stays verbatim in its segment, so only the same script
// matches, and its lines are never read as shell.
function commandParts(command) {
  let script;
  while ((script = wrappedScript(command)) !== null) command = script;
  const segments = [];
  const operators = [];
  const opaque = () => ({ key: JSON.stringify(command), segments: [], operators: [], unsupported: true });
  let quote = '';
  let depth = 0;
  let words = [];
  let wordStart = 0;
  let simple = true;
  let inlineInput = false;
  let unsupported = false;
  let heredocs = []; // here-documents opened on the current line; their bodies follow its newline
  const endWord = (end) => {
    if (wordStart < end) words.push(command.slice(wordStart, end));
  };
  const addSegment = (end, body = '') => {
    endWord(end);
    if (!words.length) return false;
    if (hidesExit(words, inlineInput)) unsupported = true;
    segments.push({ command: words.join(' ') + body, simple });
    words = [];
    simple = true;
    inlineInput = false;
    return true;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === '\\' && quote !== "'") { i += 1; continue; }
    if (quote !== "'" && c === '`') return opaque();
    if (quote !== "'" && command.startsWith('$(', i)) {
      // A leading assignment may use a simple substitution, e.g. ESBUILD="$(npm root -g)/esbuild".
      // Keep its spelling intact. More complex or nested scripts need a shell parser to interpret.
      const sub = /^\$\([\w./+-]+(?:[ \t]+[\w./+-]+)*\)/.exec(command.slice(i));
      if (!sub || !ASSIGNMENT.test(command.slice(wordStart, i)) || !words.every((w) => ASSIGNMENT.test(w))) return opaque();
      i += sub[0].length - 1;
      continue;
    }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if ((c === '#' && (i === 0 || /\s/.test(command[i - 1]))) || command.startsWith("$'", i)) return opaque();
    if (command.startsWith('<<<', i)) { simple = false; inlineInput = true; i += 2; continue; }
    if (command.startsWith('<<', i)) {
      const doc = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([^\s;&|<>()'"`]+))/.exec(command.slice(i));
      if (!doc || depth) return opaque();
      heredocs.push({ delimiter: doc[2] ?? doc[3] ?? doc[5], tabs: doc[1] === '-', quoted: doc[5] === undefined || doc[4] === '\\' });
      simple = false;
      inlineInput = true;
      i += doc[0].length - 1;
      continue;
    }
    if (c === '\n' && heredocs.length && !depth) {
      // The bodies come in the order they were opened, each up to a line holding only its delimiter.
      let pos = i + 1;
      for (const doc of heredocs) {
        for (;;) {
          if (pos > command.length) return opaque();
          const end = command.indexOf('\n', pos);
          const line = command.slice(pos, end === -1 ? command.length : end);
          pos = end === -1 ? command.length + 1 : end + 1;
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) break;
          if (end === -1) return opaque(); // the delimiter never comes
          // an unquoted body still runs $(…) and `…` in the outer shell, out of the exit's sight
          if (!doc.quoted && /\$\(|`/.test(line)) unsupported = true;
        }
      }
      addSegment(i, command.slice(i, pos - 1));
      heredocs = [];
      // the newline after the last delimiter separates commands like any other
      if (command.slice(pos).trim()) operators.push('\n');
      wordStart = pos;
      i = pos - 1;
      continue;
    }
    if (c === '(' || c === '{') { depth += 1; simple = false; unsupported = true; continue; }
    if (c === ')' || c === '}') { if (!depth) return opaque(); depth -= 1; continue; }
    if (depth) continue;
    // Normalize only shell separators. Quoted and escaped spaces, tabs and newlines belong to the argument.
    if (c === ' ' || c === '\t') {
      endWord(i);
      wordStart = i + 1;
      continue;
    }
    const op = ['&&', '||'].find((value) => command.startsWith(value, i))
      ?? ([';', '|', '\n'].includes(c) ? c : null);
    if (op) {
      const added = addSegment(i);
      if (added || op !== '\n') operators.push(op);
      i += op.length - 1;
      wordStart = i + 1;
    } else if ('<>&'.includes(c)) {
      simple = false; // redirects/backgrounding are not extra arguments
      // Descriptor duplication (2>&1) and &> redirects preserve the program's
      // exit. A background list's exit can instead come from another command.
      if (c === '&' && !['<', '>'].includes(command[i - 1]) && command[i + 1] !== '>') unsupported = true;
    }
  }
  if (quote || depth || heredocs.length) return opaque();
  if (!addSegment(command.length) && operators.at(-1) === '\n') operators.pop();
  return { key: JSON.stringify([segments.map((s) => s.command), operators]), segments, operators, unsupported };
}

// An event reports the whole shell command's exit, not each segment's. Only use it
// for a segment when that segment's outcome follows from the operators and exit.
function segmentExitKnown(event, index) {
  const { segments, operators, exit_code } = event;
  if (event.unsupported || exit_code === null || operators.length !== segments.length - 1) return false;
  // Backgrounding, grouping and redirects are not represented by the operator
  // list alone, so do not infer a component's outcome from those compound events.
  if (segments.some((part) => !part.simple)) return false;
  if (!operators.every((op) => ['&&', ';', '\n'].includes(op))) return false;
  // A successful AND chain proves every component passed. A failing one does
  // not identify the failed component, or show whether later components ran.
  if (exit_code === 0 && operators.every((op) => op === '&&')) return true;
  if (index !== segments.length - 1) return false;
  // The last command in a sequence supplies its exit. With an AND before it,
  // only success proves it actually ran; failure may have stopped the chain.
  return exit_code === 0 || operators.every((op) => op === ';' || op === '\n');
}

function wholeExitKnown({ segments, operators, unsupported, exit_code }) {
  if (unsupported || exit_code === null || operators.length !== segments.length - 1) return false;
  // In a sequence, a final success can hide an earlier failure.
  return operators.every((op) => op === '&&' || (exit_code !== 0 && (op === ';' || op === '\n')));
}

async function completedCommands(file) {
  const commands = [];
  const lines = createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const item = event?.item;
      if (event?.type !== 'item.completed' || item?.type !== 'command_execution'
        || typeof item.command !== 'string' || !item.command.trim()) continue;
      const command = wrappedScript(item.command) ?? item.command;
      commands.push({
        index: commands.length,
        command,
        ...commandParts(command),
        exit_code: Number.isInteger(item.exit_code) ? item.exit_code : null,
        status: typeof item.status === 'string' ? item.status : null,
      });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return commands;
}

export const unknownVerification = () => ({ label: 'unknown', checks: [], gaps: [] });

export async function confirmVerification(reply, file) {
  if (!Array.isArray(reply.checks)) return unknownVerification();
  const commands = reply.checks.length ? await completedCommands(file) : [];
  const checks = reply.checks.map((check) => ({ ...check, confirmation: check.outcome === 'skipped' ? 'skipped' : 'unconfirmed' }));
  const claims = checks.filter((check) => check.outcome !== 'skipped')
    .map((check) => ({ check, claim: commandParts(check.command) })).reverse();
  const used = new Set();
  const before = new Map();
  function record(check, event, known) {
    used.add(event);
    const { command, exit_code, status } = event;
    check.event = { command, exit_code, status };
    if (known) check.confirmation = (exit_code === 0) === (check.outcome === 'passed') ? 'confirmed' : 'contradicted';
  }
  // Reserve whole commands first, including compound commands. Separate calls share no shell context.
  // For reruns, the last listed check gets the latest matching run, regardless of the claimed outcome.
  const exact = Map.groupBy(commands, (event) => event.key);
  for (const { check, claim } of claims) {
    const event = exact.get(claim.key)?.pop();
    if (!event) continue;
    before.set(claim.key, event.index);
    record(check, event, !claim.unsupported && wholeExitKnown(event));
  }
  for (const { check, claim } of claims) {
    if (check.event || claim.unsupported || claim.segments.length !== 1 || claim.operators.length) continue;
    const limit = before.get(claim.key) ?? commands.length;
    const matches = (part) => part.command === claim.segments[0].command;
    const event = commands.findLast((e) => e.index < limit && !used.has(e) && e.segments.some(matches));
    if (!event) continue;
    // An ambiguous later attempt cannot resurrect an older success for this claim.
    before.set(claim.key, event.index);
    if (event.segments.some((part, i) => matches(part) && segmentExitKnown(event, i))) record(check, event, true);
  }
  const gaps = reply.gaps ?? [];
  const confirmed = checks.filter((c) => c.confirmation === 'confirmed').length;
  const label = !confirmed ? 'static-analysis-only'
    : confirmed === checks.length && !gaps.length ? 'executed' : 'partial';
  return { label, checks, gaps };
}

export function verificationLines(receipt, heading = 'Verification', legacyTests = '') {
  const { label, checks, gaps } = receipt ?? unknownVerification();
  const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();
  const showCommand = (command) => /[\r\n]/.test(command) ? JSON.stringify(command) : command;
  const lines = [`${heading}: ${label}`, ''];
  if (label === 'unknown') {
    lines.push(legacyTests ? `- Legacy Tests claim (unconfirmed): ${oneLine(legacyTests)}` : '- Checks not reported.');
  } else if (!checks.length) lines.push('- No verification checks reported.');
  for (const check of checks) {
    const evidence = (check.event ? [check.event] : check.events ?? []).map((event) =>
      `; ${check.events ? `${showCommand(event.command)}: ` : ''}exit ${event.exit_code ?? 'unknown'}${event.status ? `; ${event.status}` : ''}`).join('');
    const confirmation = check.outcome === 'skipped' ? '' : ` [${check.confirmation}${evidence}]`;
    lines.push(`- ${check.outcome}${confirmation}: ${showCommand(check.command)}${check.note ? ` — ${oneLine(check.note)}` : ''}`);
    if (check.event?.command) lines.push(`  Matched command: ${showCommand(check.event.command)}`);
  }
  lines.push(...gaps.map((gap) => `- Gap: ${oneLine(gap)}`));
  return lines;
}
