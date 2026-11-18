// A static shell reader for the commit guard, not a shell interpreter. Quoted words keep their values
// for paths and shell -c/eval; only executable positions and substitutions are inspected for Git.
type Dir = string | null
type Word = { value: string; quoted: boolean; tilde: boolean; assignment?: string }
type Heredoc = { tag: Word; tabs: boolean; body: string }
type Redirects = { substitutions: Node[][]; docs: Heredoc[]; stdin?: Heredoc | string | null; stdout: boolean; negated?: boolean }
type Simple = Redirects & { kind: 'simple'; words: Word[]; end: string }
type Group = Redirects & { kind: 'group'; body: Node[]; isolated: boolean; end: string }
type Arm = { condition?: Node[]; body: Node[]; fallthrough?: 'next' | 'retest' }
type Choice = Redirects & { kind: 'choice'; arms: Arm[]; exhaustive: boolean; end: string }
type Node = Simple | Group | Choice
type DirStack = { cwd: Dir; next: DirStack | null }
type Context = { cwd: Dir; previous: Dir; stack: DirStack | null; env: Record<string, Word> }
// cwd is the lexical work tree. Keep the target spellings for stat: link/.. can land
// somewhere else, and .git itself may be a symlink.
export type GitWrite = { action: 'commit' | 'push' | 'stash'; cwd: Dir; dirs: Dir[] }

const redirects = (): Redirects => ({ substitutions: [], docs: [], stdout: false })
const simple = (): Simple => ({ ...redirects(), kind: 'simple', words: [], end: '' })
const group = (body: Node[], isolated: boolean, end = ''): Group => ({ ...redirects(), kind: 'group', body, isolated, end })
const space = (c: string) => c === ' ' || c === '\t' || c === '\r'
const boundary = (c: string) => '; &|\n()<>'.includes(c)
const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const reserved = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!'])
const assignment = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/s
const dynamic = /[$`*?[]/
const program = (value: string) => value.slice(value.lastIndexOf('/') + 1)
const fork = (ctx: Context): Context => ({ ...ctx, env: { ...ctx.env } })

function join(a: Context | null, b: Context): Context {
  if (!a) return fork(b)
  const env = { ...a.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE']) {
    if (a.env[key]?.value !== b.env[key]?.value || a.env[key]?.tilde !== b.env[key]?.tilde) {
      env[key] = { value: '$?', quoted: false, tilde: false }
    }
  }
  return { cwd: a.cwd === b.cwd ? a.cwd : null, previous: a.previous === b.previous ? a.previous : null, stack: a.stack === b.stack ? a.stack : null, env }
}

// A shared cursor consumes each source level once, including comments and pending heredocs. In
// particular, no regexp repeatedly searches the unconsumed suffix of a long command.
class Reader {
  private at = 0
  constructor(private text: string) {}

  private atWord(word: string) {
    const next = this.text[this.at + word.length]
    return this.text.startsWith(word, this.at) && (!next || space(next) || boundary(next))
  }

  private take(word: string) {
    if (!this.atWord(word)) return false
    this.at += word.length
    return true
  }

  private trivia(pending: Heredoc[]) {
    while (this.at < this.text.length) {
      const c = this.text[this.at]
      if (c === '\n') {
        this.at++
        for (const doc of pending) this.heredoc(doc)
        pending.length = 0
      } else if (space(c)) this.at++
      else if (this.text.startsWith('\\\n', this.at)) this.at += 2
      else if (c === '#') {
        const end = this.text.indexOf('\n', this.at)
        this.at = end < 0 ? this.text.length : end
      } else break
    }
  }

  private conditional(pending: Heredoc[]): Choice {
    const arms: Arm[] = []
    do {
      const condition = this.read('', ['then'], pending)
      if (!this.take('then')) throw new Error('expected then')
      arms.push({ condition, body: this.read('', ['elif', 'else', 'fi'], pending) })
    } while (this.take('elif'))
    const exhaustive = this.take('else')
    if (exhaustive) arms.push({ body: this.read('', ['fi'], pending) })
    if (!this.take('fi')) throw new Error('expected fi')
    return { ...redirects(), kind: 'choice', arms, exhaustive, end: '' }
  }

  private cases(pending: Heredoc[]): Choice {
    const choice: Choice = { ...redirects(), kind: 'choice', arms: [], exhaustive: false, end: '' }
    this.trivia(pending)
    this.word(choice.substitutions) // the subject and patterns are data, but their substitutions run
    this.trivia(pending)
    if (!this.take('in')) throw new Error('expected in')
    for (;;) {
      this.trivia(pending)
      if (this.take('esac')) return choice
      if (this.text[this.at] === '(') this.at++
      for (;;) {
        this.trivia(pending)
        const start = this.at
        const pattern = this.word(choice.substitutions)
        if (this.at === start) throw new Error('expected case pattern')
        if (!pattern.quoted && pattern.value === '*') choice.exhaustive = true
        this.trivia(pending)
        const separator = this.text[this.at++]
        if (separator === ')') break
        if (separator !== '|') throw new Error('expected case pattern separator')
      }
      const arm: Arm = { body: this.read('', ['esac'], pending, true) }
      choice.arms.push(arm)
      if (this.text.startsWith(';;&', this.at)) {
        arm.fallthrough = 'retest'
        this.at += 3
      } else if (this.text.startsWith(';&', this.at)) {
        arm.fallthrough = 'next'
        this.at += 2
      } else if (this.text.startsWith(';;', this.at)) this.at += 2
      else if (this.take('esac')) return choice
      else throw new Error('unsupported case terminator')
    }
  }

  read(stop = '', keywords: string[] = [], pending: Heredoc[] = [], caseBody = false): Node[] {
    const nodes: Node[] = []
    let cmd = simple()
    let jobStart = 0
    const flush = (end = '') => {
      if (cmd.words.length || cmd.docs.length || cmd.substitutions.length) {
        cmd.end = end
        nodes.push(cmd)
        cmd = simple()
      } else if (nodes.length && end) nodes[nodes.length - 1].end = end
    }
    const prefix = () => cmd.words.every((w) => !w.quoted && (reserved.has(w.value) || w.value === 'time' || w.value === '-p'))
    const compound = (node: Choice | Group) => {
      if (prefix()) {
        node.negated = cmd.words.filter((w) => w.value === '!').length % 2 === 1
        node.stdin = cmd.stdin
        node.stdout = cmd.stdout
        node.docs.push(...cmd.docs)
        node.substitutions.push(...cmd.substitutions)
        cmd = simple()
      } else flush()
      nodes.push(node)
    }
    while (this.at < this.text.length) {
      const c = this.text[this.at]
      if (caseBody && (this.text.startsWith(';;', this.at) || this.text.startsWith(';&', this.at))) break
      if (!cmd.words.length && keywords.some((word) => this.atWord(word))) break
      const braceEnd = this.at + 1 === this.text.length || space(this.text[this.at + 1]) || boundary(this.text[this.at + 1])
      if (stop && c === stop && (stop !== '}' || (braceEnd && !cmd.words.length))) {
        this.at++
        break
      }
      if (space(c)) {
        this.at++
      } else if (c === '\\' && this.text[this.at + 1] === '\n') {
        this.at += 2
      } else if (c === '#') {
        const end = this.text.indexOf('\n', this.at)
        this.at = end < 0 ? this.text.length : end
      } else if (c === '\n') {
        this.at++
        const continued = !cmd.words.length && !cmd.docs.length && !cmd.substitutions.length
          && ['&&', '||', '|'].includes(nodes.at(-1)?.end ?? '')
        if (!continued) {
          flush('\n')
          jobStart = nodes.length
        }
        for (const doc of pending) this.heredoc(doc)
        pending.length = 0
      } else if (c === ';' || c === '&' || c === '|') {
        this.at++
        let op = c
        if (this.text[this.at] === c) op += this.text[this.at++]
        // Bash's |& is a pipe too; & here belongs to the pipe, not to a second job.
        if (op === '|' && this.text[this.at] === '&') this.at++
        flush(op)
        if (op === '&') {
          // & backgrounds the entire AND/OR list, so its earlier cd must not escape either.
          const body = nodes.splice(jobStart)
          nodes.push(group(body, true, '&'))
        }
        if (op === ';' || op === '&') jobStart = nodes.length
      } else if (this.atWord('if') && prefix()) {
        this.at += 2
        compound(this.conditional(pending))
      } else if (this.atWord('case') && prefix()) {
        this.at += 4
        compound(this.cases(pending))
      } else if (c === '(' || (c === '{' && braceEnd && prefix())) {
        this.at++
        compound(group(this.read(c === '(' ? ')' : '}'), c === '('))
      } else if (c === ')') {
        this.at++
        flush()
      } else if ((c === '<' || c === '>') && this.text[this.at + 1] === '(') {
        this.at += 2
        cmd.substitutions.push(this.read(')')) // process substitution
      } else {
        // An IO number is part of a redirection, not an argument (2>file, 3<<EOF).
        let io = this.at
        while (io < this.text.length && /[0-9]/.test(this.text[io])) io++
        if (this.text[io] === '<' || this.text[io] === '>') {
          const fd = io > this.at ? Number(this.text.slice(this.at, io)) : this.text[io] === '<' ? 0 : 1
          this.at = io
          const last = nodes.at(-1)
          const target = !cmd.words.length && !cmd.docs.length && !cmd.substitutions.length && last && last.kind !== 'simple' && !last.end ? last : cmd
          this.redirect(target, pending, fd)
        } else {
          cmd.words.push(this.word(cmd.substitutions))
        }
      }
    }
    flush()
    return nodes
  }

  private redirect(cmd: Redirects, pending: Heredoc[], fd: number) {
    const c = this.text[this.at++]
    if (fd === 0) cmd.stdin = null
    if (fd === 1) cmd.stdout = true
    if (c === '<' && this.text.startsWith('<<', this.at)) {
      this.at += 2
      while (space(this.text[this.at])) this.at++
      const word = this.word(cmd.substitutions)
      if (fd === 0) cmd.stdin = word.value
      return
    }
    if (c === '<' && this.text[this.at] === '<') {
      this.at++
      const tabs = this.text[this.at] === '-'
      if (tabs) this.at++
      while (space(this.text[this.at])) this.at++
      const doc = { tag: this.word([]), tabs, body: '' }
      cmd.docs.push(doc)
      pending.push(doc)
      if (fd === 0) cmd.stdin = doc
      return
    }
    while ('<>&|'.includes(this.text[this.at] ?? '\0')) this.at++
    while (space(this.text[this.at])) this.at++
    if (this.at < this.text.length && !boundary(this.text[this.at])) this.word(cmd.substitutions)
  }

  private heredoc(doc: Heredoc) {
    const start = this.at
    while (this.at < this.text.length) {
      const end = this.text.indexOf('\n', this.at)
      const until = end < 0 ? this.text.length : end
      const line = this.text.slice(this.at, until)
      if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.tag.value) {
        doc.body = this.text.slice(start, this.at)
        if (doc.tabs) doc.body = doc.body.replace(/^\t+/gm, '')
        this.at = end < 0 ? until : end + 1
        return
      }
      this.at = end < 0 ? until : end + 1
    }
    doc.body = this.text.slice(start)
  }

  private substitution(out: Node[][]): boolean {
    const c = this.text[this.at]
    if (c === '$' && this.text[this.at + 1] === '(') {
      this.at += 2
      out.push(this.read(')'))
      return true
    }
    if (c === '`') {
      this.at++
      let body = ''
      while (this.at < this.text.length && this.text[this.at] !== '`') {
        // Legacy substitution removes one escape level before its inner shell reads the command.
        // This makes escaped backticks into a nested substitution, including inside double quotes.
        if (this.text[this.at] === '\\' && '$`\\'.includes(this.text[this.at + 1] ?? '\0')) this.at++
        body += this.text[this.at++]
      }
      if (this.text[this.at] === '`') this.at++
      out.push(new Reader(body).read())
      return true
    }
    return false
  }

  // Heredoc expansion differs from double quoting: quotes in its body are literal, while backslash
  // can escape $, ` and itself. Only an unquoted delimiter enables these substitutions.
  expandHeredoc(): { text: string; substitutions: Node[][] } {
    const substitutions: Node[][] = []
    let text = ''
    while (this.at < this.text.length) {
      if (this.text[this.at] === '\\' && '$`\\\n'.includes(this.text[this.at + 1] ?? '\0')) {
        this.at++
        if (this.text[this.at] !== '\n') text += this.text[this.at]
        this.at++
      } else if (this.substitution(substitutions)) text += '$?'
      else text += this.text[this.at++]
    }
    return { text, substitutions }
  }

  private parameter(substitutions: Node[][], inDouble: boolean) {
    this.at += 2 // ${
    while (this.at < this.text.length && this.text[this.at] !== '}') {
      const c = this.text[this.at]
      if (c === '\\') this.at += 2
      else if (!inDouble && (c === "'" || (c === '$' && this.text[this.at + 1] === "'"))) {
        const ansi = c === '$'
        this.at += ansi ? 2 : 1
        while (this.at < this.text.length && this.text[this.at] !== "'") {
          if (ansi && this.text[this.at] === '\\') this.at++
          this.at++
        }
        if (this.text[this.at] === "'") this.at++
      } else if (c === '"') this.doubleQuoted(substitutions)
      else if (c === '$' && this.text[this.at + 1] === '{') this.parameter(substitutions, inDouble)
      else if (!this.substitution(substitutions)) this.at++
    }
    if (this.text[this.at] === '}') this.at++
  }

  private doubleQuoted(substitutions: Node[][]): string {
    this.at++
    let value = ''
    while (this.at < this.text.length && this.text[this.at] !== '"') {
      if (this.text[this.at] === '\\' && '$`"\\\n'.includes(this.text[this.at + 1] ?? '\0')) {
        this.at++
        if (this.text[this.at] !== '\n') value += this.text[this.at]
        this.at++
      } else if (this.text[this.at] === '$' && this.text[this.at + 1] === '{') {
        this.parameter(substitutions, true)
        value += '$?'
      } else if (this.substitution(substitutions)) value += '$?'
      else value += this.text[this.at++]
    }
    if (this.text[this.at] === '"') this.at++
    return value
  }

  private word(substitutions: Node[][]): Word {
    let value = ''
    let quoted = false
    let tilde = false
    let assignmentKey: string | undefined
    while (this.at < this.text.length) {
      const c = this.text[this.at]
      if (space(c) || boundary(c)) break
      if (c === '\\') {
        quoted = true
        this.at++
        if (this.text[this.at] !== '\n') value += this.text[this.at] ?? ''
        this.at++
      } else if (c === "'" || (c === '$' && this.text[this.at + 1] === "'")) {
        quoted = true
        const ansi = c === '$'
        this.at += ansi ? 2 : 1
        let inner = ''
        while (this.at < this.text.length && this.text[this.at] !== "'") {
          if (ansi && this.text[this.at] === '\\') inner += this.text[this.at++]
          inner += this.text[this.at++] ?? ''
        }
        if (this.text[this.at] === "'") this.at++
        value += ansi ? inner.replace(/\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{4}|[0-7]{1,3}|.)/g, (_m, esc: string) => {
          const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' }
          if (named[esc] !== undefined) return named[esc]
          if (esc[0] === 'x' || esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16))
          return /^[0-7]/.test(esc) ? String.fromCharCode(parseInt(esc, 8)) : `\\${esc}`
        }) : inner
      } else if (c === '"') {
        quoted = true
        value += this.doubleQuoted(substitutions)
      } else if (this.substitution(substitutions)) {
        value += '$?' // its value is unknown; its executable body is already a separate tree
      } else if (c === '$' && this.text[this.at + 1] === '{') {
        this.parameter(substitutions, false)
        value += '$?'
      } else {
        if (c === '=' && !quoted && /^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) assignmentKey = value
        if (c === '~' && (!value || (value.endsWith('=') && /^[A-Za-z_][A-Za-z_0-9]*=$/.test(value)))) {
          // A quoted or escaped tilde is a literal directory name, including in assignments.
          let end = this.at + 1
          tilde = true
          while (end < this.text.length && this.text[end] !== '/' && !space(this.text[end]) && !boundary(this.text[end])) {
            if ('\'"\\'.includes(this.text[end++])) tilde = false
          }
        }
        value += c
        this.at++
      }
    }
    return { value, quoted, tilde, assignment: assignmentKey }
  }
}

export function lexicalPath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

// cd normally processes .. logically; Git -C and wrappers that chdir use the filesystem.
function resolveDir(cwd: Dir, word: Word | string, home: string, physical = false): Dir {
  let target = typeof word === 'string' ? word : word.value
  if (dynamic.test(target)) return null
  if (target.startsWith('~') && (typeof word === 'string' || word.tilde)) {
    if (!/^~(?:\/|$)/.test(target) || !home) return null
    target = home + target.slice(1)
  }
  if (!target.startsWith('/')) {
    if (cwd === null) return null
    target = `${cwd}/${target}`
  }
  return physical ? target : lexicalPath(target)
}

const envKey = (key: string) => key === 'GIT_DIR' || key === 'GIT_WORK_TREE'
const wrappers = new Set(['env', 'sudo', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'xargs', 'time'])
const wrapperValues: Record<string, Set<string>> = {
  env: new Set(['-u', '-C', '-a', '-S', '--unset', '--chdir', '--argv0', '--split-string']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-R', '-D', '-r', '-t', '--user', '--group', '--host', '--prompt', '--close-from', '--command-timeout', '--chroot', '--chdir', '--role', '--type', '--other-user']),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']),
  time: new Set(['-o', '-f', '--output', '--format']),
  exec: new Set(['-a']),
}

// env -S splits arguments, not shell commands. Shell operators in an argument are data.
// Expansion and env-specific escape sequences outside this literal subset are unknown.
function splitEnv(value: string): Word[] {
  const words: Word[] = []
  let quote = ''
  let part = ''
  let started = false
  const flush = () => {
    if (started) words.push({ value: part, tilde: false, quoted: true })
    part = ''
    started = false
  }
  for (const c of value) {
    if (c === '\\' || (c === '$' && quote !== "'")) throw new Error('dynamic env split string')
    if (!quote && c === '#' && !started) break
    if (!quote && /\s/.test(c)) flush()
    else {
      started = true
      if (quote && c === quote) quote = ''
      else if (!quote && (c === "'" || c === '"')) quote = c
      else part += c
    }
  }
  if (quote) throw new Error('unterminated env split string')
  flush()
  return words
}

// Consume wrapper options once, including their values, before looking for the actual executable.
function executable(words: Word[], ctx: Context, home: string): number {
  let i = 0
  let leading = true
  let envAssignments = false
  while (i < words.length) {
    const arg = words[i].value
    const assigned = ((leading && words[i].assignment) || envAssignments) ? assignment.exec(arg) : null
    if (assigned) {
      if (envKey(assigned[1])) ctx.env[assigned[1]] = { ...words[i], value: assigned[2] }
      i++
      continue
    }
    if (!words[i].quoted && reserved.has(arg)) {
      i++
      continue
    }
    const name = program(arg)
    if (!wrappers.has(name)) return i
    if (name !== 'time') leading = false
    envAssignments = name === 'env' || name === 'sudo'
    i++
    while (i < words.length && words[i].value.startsWith('-') && (words[i].value !== '-' || name === 'env')) {
      const optionWord = words[i++]
      const option = optionWord.value
      if (option === '--') break
      let key = option
      let value: Word | undefined
      const values = wrapperValues[name]
      if (option.startsWith('--')) {
        const equal = option.indexOf('=')
        key = equal < 0 ? option : option.slice(0, equal)
        if (values?.has(key)) value = equal < 0 ? words[i++] : { ...optionWord, value: option.slice(equal + 1) }
      } else {
        // Short flags may be clustered; an option taking a value consumes the rest of the cluster
        // or the next word. Thus -nu bob, -ubob, -n 10 and -n10 all reach the right executable.
        for (let j = 1; j < option.length; j++) {
          key = `-${option[j]}`
          if (name === 'command' && (key === '-v' || key === '-V')) return words.length
          if (name === 'env' && key === '-i') ctx.env = {}
          if (values?.has(key)) {
            value = j + 1 < option.length ? { ...optionWord, value: option.slice(j + 1) } : words[i++]
            break
          }
        }
      }
      if (name === 'env' && (option === '-' || key === '--ignore-environment')) ctx.env = {}
      if (name === 'env' && (key === '-u' || key === '--unset') && value) delete ctx.env[value.value]
      if (name === 'env' && (key === '-S' || key === '--split-string') && value) {
        words.splice(i, 0, ...splitEnv(value.value))
      }
      if ((name === 'env' && (key === '-C' || key === '--chdir')) || (name === 'sudo' && (key === '-D' || key === '--chdir'))) {
        ctx.cwd = value === undefined ? null : resolveDir(ctx.cwd, value, home, true)
      }
    }
    if (name === 'timeout' && i < words.length) i++ // duration
  }
  return i
}

function gitWrite(words: Word[], at: number, ctx: Context, home: string): GitWrite | null {
  let cwd = ctx.cwd
  let gitDir = ctx.env.GIT_DIR
  let workTree = ctx.env.GIT_WORK_TREE
  let i = at
  while (i < words.length) {
    const word = words[i++]
    const arg = word.value
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') {
      i--
      break
    }
    const equal = arg.indexOf('=')
    const key = equal < 0 ? arg : arg.slice(0, equal)
    if (arg === '-C' || (arg.startsWith('-C') && arg.length > 2)) {
      const dir = arg === '-C' ? words[i++] : { ...word, value: arg.slice(2) }
      cwd = dir === undefined ? null : resolveDir(cwd, dir, home, true)
    } else if (key === '--work-tree' || key === '--git-dir') {
      const dir = equal < 0 ? words[i++] : { ...word, value: arg.slice(equal + 1) }
      if (key === '--work-tree') workTree = dir
      else gitDir = dir
    } else if (arg === '-c' || key === '--namespace' || key === '--config-env' || key === '--super-prefix' || key === '--attr-source') {
      if (equal < 0) i++
    }
    // All remaining global flags have no separate value, including --exec-path[=path].
  }
  const action = words[i]?.value
  if (action !== 'commit' && action !== 'push' && action !== 'stash') return null
  if (action === 'stash' && ['list', 'show'].includes(words[i + 1]?.value)) return null
  const repoDir = gitDir === undefined ? undefined : resolveDir(cwd, gitDir, home, true)
  if (workTree !== undefined) cwd = resolveDir(cwd, workTree, home, true)
  else if (repoDir !== undefined) cwd = repoDir
  const logical = cwd === null ? null : lexicalPath(cwd)
  return {
    action,
    cwd: workTree === undefined && repoDir !== undefined && logical?.endsWith('/.git') ? logical.slice(0, -5) || '/' : logical,
    dirs: repoDir !== undefined && repoDir !== cwd ? [cwd, repoDir] : [cwd],
  }
}

// The next operand of an AND/OR list sees only the exits on which it actually runs.
// Join at each operator so the number of contexts stays constant even for long chains.
type Exits = { success: Context; failure: Context; output?: string }
function inspect(nodes: Node[], ctx: Context, home: string, writes: GitWrite[], input?: string): Exits {
  let exits: Exits = { success: ctx, failure: ctx }
  let previous = ''
  for (let i = 0; i < nodes.length; i++) {
    let node = nodes[i]
    const entry = previous === '&&' ? exits.success : previous === '||' ? exits.failure : ctx
    const pipeline = node.end === '|'
    const negated = node.negated || (node.kind === 'simple' && !node.words[0]?.quoted && node.words[0]?.value === '!')
    let local = fork(entry)
    let result = inspectNode(node, local, home, writes, input)
    while (node.end === '|' && i + 1 < nodes.length) {
      node = nodes[++i]
      result = inspectNode(node, fork(entry), home, writes, result.output)
    }
    // All stages run in separate shells. Only their data passes from one to the next.
    if (pipeline) {
      local = entry
      result = { success: entry, failure: entry, output: result.output }
    }
    if (negated) [result.success, result.failure] = [result.failure, result.success]
    if (previous === '&&') {
      result.failure = join(exits.failure, result.failure)
      Object.assign(ctx, join(ctx, local))
    } else if (previous === '||') {
      Object.assign(ctx, join(exits.success, local))
      result.success = join(exits.success, result.success)
    } else Object.assign(ctx, local)
    exits = result
    previous = node.end
  }
  // Forward known stdin only through a single command. Other output is runtime-built.
  return { ...exits, output: nodes.length === 1 ? exits.output : undefined }
}

function inspectNode(node: Node, local: Context, home: string, writes: GitWrite[], input?: string): Exits {
  for (const sub of node.substitutions) inspect(sub, fork(local), home, writes)
  let stdin = node.stdin === undefined ? input : typeof node.stdin === 'string' ? node.stdin : node.stdin?.body
  for (const doc of node.docs) {
    if (!doc.tag.quoted) {
      const expanded = new Reader(doc.body).expandHeredoc()
      for (const sub of expanded.substitutions) inspect(sub, fork(local), home, writes)
      if (doc === node.stdin) stdin = expanded.text
    }
  }
  if (node.kind === 'choice') {
    let remaining = fork(local)
    let after: Context | null = null
    let success: Context | null = null
    let failure: Context | null = null
    let nextBody: Context | null = null
    for (const arm of node.arms) {
      const condition = arm.condition ? inspect(arm.condition, remaining, home, writes, stdin) : null
      const body = join(nextBody, condition?.success ?? remaining)
      if (condition) remaining = condition.failure
      const result = inspect(arm.body, body, home, writes, stdin)
      nextBody = arm.fallthrough === 'next' ? body : null
      if (arm.fallthrough === 'retest') remaining = join(remaining, body)
      if (nextBody && arm !== node.arms.at(-1)) continue
      success = join(success, result.success)
      failure = join(failure, result.failure)
      after = join(after, body)
    }
    // An if without else or a case without a catch-all can execute no body.
    if (!node.exhaustive) {
      after = join(after, remaining)
      success = join(success, remaining)
    }
    Object.assign(local, after)
    return { success: success ?? local, failure: failure ?? local }
  }
  if (node.kind === 'group') {
    const result = inspect(node.body, node.isolated ? fork(local) : local, home, writes, stdin)
    return { success: node.isolated ? local : result.success, failure: node.isolated ? local : result.failure,
      output: node.stdout ? undefined : result.output }
  }
  // A failed cd leaves the previous directory. An eval can have made changes on either exit.
  const exits = { success: local, failure: fork(local) }
  const output = inspectSimple(node, local, exits, home, writes, stdin)
  return { ...exits, output: node.stdout ? undefined : output }
}

function inspectSimple(node: Simple, local: Context, exits: Exits, home: string, writes: GitWrite[], stdinScript?: string): string | undefined {
  const invocation = fork(local)
  const words = [...node.words] // env -S can insert words into the argument vector
  const at = executable(words, invocation, home)
  if (at >= words.length) {
    // Assignment-only commands persist; assignments in env/sudo invocations do not.
    if (node.words.every((w) => w.assignment)) local.env = invocation.env
    return
  }
  const name = program(words[at].value)
  const args = words.slice(at + 1)
  if (name === 'git') {
    const write = gitWrite(words, at + 1, invocation, home)
    if (write) writes.push(write)
  } else if (name === 'export') {
    for (const word of args) {
      const match = assignment.exec(word.value)
      if (match && envKey(match[1])) local.env[match[1]] = { ...word, value: match[2] }
    }
  } else if (name === 'unset') {
    for (const word of args) if (envKey(word.value)) delete local.env[word.value]
  } else if (name === 'cd' || name === 'pushd') {
    const afterOptions = args.findIndex((w) => w.value === '--')
    const given = afterOptions < 0 ? args.find((w) => w.value === '-' || !w.value.startsWith('-')) : args[afterOptions + 1]
    const index = name === 'pushd' && args.find((w) => /^[+-]\d+$/.test(w.value))
    if (index) {
      const dirs = [local.cwd]
      for (let at = local.stack; at; at = at.next) dirs.push(at.cwd)
      const n = Number(index.value.slice(1))
      const from = index.value[0] === '+' ? n : dirs.length - 1 - n
      if (from < 0 || from >= dirs.length || args.some((w) => w.value === '-n')) {
        local.cwd = null // an inherited directory stack or shell-specific -n rotation
        local.previous = null
        local.stack = null
      } else if (from) {
        const rotated = [...dirs.slice(from), ...dirs.slice(0, from)]
        local.previous = local.cwd
        local.cwd = rotated[0]
        local.stack = null
        for (let i = rotated.length - 1; i > 0; i--) local.stack = { cwd: rotated[i], next: local.stack }
      }
      return
    }
    if (name === 'pushd' && !given) {
      const dir = local.stack?.cwd ?? null
      if (local.stack) local.stack = { cwd: local.cwd, next: local.stack.next }
      local.previous = local.cwd
      local.cwd = dir
      return
    }
    const target = given ?? home
    const dir = typeof target !== 'string' && target.value === '-' ? local.previous : resolveDir(local.cwd, target, home)
    if (name === 'pushd') {
      const noCd = args.some((w) => w.value === '-n')
      local.stack = { cwd: noCd ? dir : local.cwd, next: local.stack }
      if (noCd) return
    }
    local.previous = local.cwd
    local.cwd = dir
  } else if (name === 'popd') {
    if (!args.some((w) => w.value === '-n')) {
      local.previous = local.cwd
      local.cwd = local.stack?.cwd ?? null
    }
    local.stack = local.stack?.next ?? null
  } else if (name === 'eval') {
    const evaluated = fork(invocation)
    const result = inspect(new Reader(args.map((w) => w.value).join(' ')).read(), evaluated, home, writes, stdinScript)
    // Prefix assignments apply while eval runs; directory changes and assignments made by the
    // evaluated code stay in this shell. Restore any temporarily shadowed environment values.
    for (let i = 0; i < at; i++) {
      const key = words[i].assignment
      if (key && envKey(key)) {
        for (const frame of [evaluated, result.success, result.failure]) {
          if (local.env[key] === undefined) delete frame.env[key]
          else frame.env[key] = local.env[key]
        }
      }
    }
    Object.assign(local, evaluated)
    Object.assign(exits, result)
    return result.output
  } else if (shells.has(name)) {
    let i = 0
    let inline = false
    let readsStdin = false
    while (i < args.length && /^[-+]./.test(args[i].value)) {
      const option = args[i++].value
      if (option === '--') break
      if (/^-[^-]*c/.test(option)) {
        inline = true
        if (args[i]?.value === '--') i++
        break
      }
      if (/^-[^-]*s/.test(option)) readsStdin = true
      if (/^[-+][^-]*[oO]$/.test(option) || ['--rcfile', '--init-file'].includes(option)) i++
    }
    if (inline && args[i]) return inspect(new Reader(args[i].value).read(), fork(invocation), home, writes, stdinScript).output
    if (!inline && (readsStdin || i === args.length || args[i].value === '-') && stdinScript !== undefined) {
      return inspect(new Reader(stdinScript).read(), fork(invocation), home, writes).output
    }
  } else if (name === 'cat' && args.every((w) => ['-', '--', '-u'].includes(w.value))) {
    return stdinScript
  }
}

// A null directory means a recognized write whose location depends on runtime expansion. The hook fails
// closed for that write whenever any session is guarded, without changing which sessions are active.
export function gitWrites(command: string, cwd: string, home: string): GitWrite[] {
  const writes: GitWrite[] = []
  inspect(new Reader(command).read(), { cwd: resolveDir('/', cwd, home), previous: null, stack: null, env: {} }, home, writes)
  return writes
}
