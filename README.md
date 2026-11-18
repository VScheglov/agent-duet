[Русский](README.ru.md) | [简体中文](README.zh-CN.md)

# agent-duet

Claude and a delegate engine, **Codex** (the default) or **agy** (Antigravity CLI), work through a review, an implementation or an audit between themselves. No copying text between chats:

- **Review** (`plan`, `code`, `file`): the delegate reviews a plan, your git changes or any files. Claude fixes each issue, disputes it with evidence, or leaves the decision to you. The loop goes on until they agree, reach a deadlock, or run out of rounds.
- **Build** (`build`): the delegate implements a specification that Claude wrote, in a git worktree of its own, and Claude reviews every round as the architect. Most of the work uses the selected engine's allowance rather than Claude's.
- **Audit** (`audit`): the delegate examines code, data or documents without changing anything and returns a one-off report of findings. Nothing is negotiated.

All five modes work with both engines. Start with `/agent-duet` or a plain-language request; `/duet` opens a live pane with the progress. The plugin has two parts: the **runner** (`scripts/duet.mjs`), which runs the delegate's turns and keeps each session's record, and a Claude Code **module** (`hooks/register.tsx`), which draws the pane, the status band and notifications and adds the loop and commit hooks. Claude runs the runner for you.

> Formerly **codex-duet** (up to 0.12.0). Sessions, preferences, environment variables and `codex-duet/` branches carry over automatically; see [Upgrading from codex-duet](#upgrading-from-codex-duet).

## Installation

### Requirements

- Claude Code 2.1.275 or newer.
- An installed, signed-in engine: [Codex CLI](https://github.com/openai/codex) with `codex` on your `PATH`, or agy (Antigravity CLI, tested with 1.5.7) with `agy` on your `PATH`. To use another binary, set `AGENT_DUET_CODEX_BIN` or `AGENT_DUET_AGY_BIN`.
- Node.js 22 or newer: the runner is a Node script.
- git, for the code and build modes.

### Supported platforms

| Platform | Support |
|---|---|
| macOS | Everything |
| Linux | Everything except sound: Claude Code has no audio player on Linux, but toasts and the status band work. If a runner was killed with `kill -9` or the machine crashed, delete its leftover session lock yourself: the `stale lock` error names the file. (On macOS the kernel releases that lock automatically, `O_EXLOCK`.) |
| Windows | Not supported: the runner and the module call `kill`, `tail`, `head`, `grep` and `diff`. WSL should behave like Linux but has not been tested |

If your organization manages Claude Code through managed settings, the `Stop` hook does not run for plugins you installed yourself, so the module cannot bring Claude back to the loop after its turn ends (see [Keeping the loop going](#keeping-the-loop-going)). Everything else works.

### Install

In a Claude Code terminal session:

```
/plugin install agent-duet --marketplace VScheglov/agent-duet
```

Answer `y` to `Add marketplace?` and choose a scope: user scope makes the plugin available in every project. The same from a shell:

```bash
claude plugin install agent-duet --marketplace VScheglov/agent-duet
```

In the Claude app, where `/plugin` is not available: click **+** next to the input, then **Plugins**, **Add marketplace** with `VScheglov/agent-duet`, and **Add plugin**.

If `/agent-duet` and `/duet` do not appear after installation, open a new session or run `/reload-plugins`. The skill's full command name is `/agent-duet:agent-duet`; the short `/agent-duet` works as long as no other command has taken that name.

### Allow 12-hour background commands (recommended)

A delegate turn can run for hours, so Claude runs it as a background command with `timeout: 43200000` (12 hours). Without configuration, Claude Code caps background commands at 2 hours and interrupts longer turns; you can then ask Claude to `retry`, which resumes the same delegate conversation when it can. To raise the cap, add this to `~/.claude/settings.json`:

```json
{ "env": { "BASH_MAX_TIMEOUT_MS": "43200000" } }
```

The setting applies to sessions opened after the change. It also raises the longest allowed foreground timeout to 12 hours.

## Usage

```
/agent-duet plan                      review the plan from plan mode or the conversation
/agent-duet code                      review uncommitted changes, including untracked files
/agent-duet code --base main          review the whole branch since its merge-base with main
/agent-duet file docs/spec.md         review any files: test cases, SQL, specs, configuration
/agent-duet build                     have the delegate implement a task in its own worktree
/agent-duet audit                     one-off read-only audit with a report of findings
/agent-duet code -- check migrations  text after `--` sets the focus
/agent-duet code --engine agy         use agy instead of Codex (works with any mode)
/agent-duet status                    current progress, also after context compaction
/duet                                 open the live pane
```

You can also ask in plain language: “have Codex review this”, “have agy review this”, “delegate to agy”, or “audit this with agy”.

**Who runs what.** You talk to Claude, and Claude drives each session through the runner's subcommands: `start`, `reply`, `review`, `retry`, `verify`, `finish`, `discard` and `status`. Where this README mentions one of them, Claude runs it for you: just ask, for example “retry the interrupted turn” or “finish the build”.

Run `list` from the source repository or the build worktree to find a build. If several sessions match, choose one with `--session <id>` for `status`, `verify` or another session command.

**Engine.** It is chosen when a session starts, with `--engine codex|agy`. Without the option, `AGENT_DUET_ENGINE` applies, then `codex`. A session keeps its engine: `reply`, `review` and `retry` cannot change it, so start a new session to use the other one. Sessions from before 0.12.0 have no engine field and stay Codex sessions.

**Options for both engines:** `--max-rounds N` (default 10), `--model`, `--effort`, `--timeout-min` (limit per turn; none by default) and `--sandbox` (default `inherit`). Model and effort can change on `reply`, `review` or `retry`. How each engine reads them is in [Engine differences](#engine-differences).

## How negotiation works

```
start ─► delegate: issues C1…Cn (JSON matching the schema)
          │
          ▼
   Claude answers each issue:  fixed · disputed · needs-user
          │
reply ─► delegate (same session, resume): resolved · withdrawn · open + counterargument · new issues
          │
          ▼
   scripts/policy.mjs → continue · done · escalate (deadlock → you)
```

- Each issue keeps its ID for the whole session. The delegate sees Claude's answers and the diff between rounds.
- If you rule for the current version (`owner-decided`), the issue closes even if the delegate disagrees.
- Reaching the round limit always escalates, whatever the policy decides.
- Claude never commits anything.

## Stop policy (`scripts/policy.mjs`)

Rules are checked from top to bottom; the first match wins:

1. Claude parked a critical/high issue (`needs-user`) → **escalate** immediately.
2. The delegate says `approve` and no critical/high issues remain open → **done**. Medium/low issues go into the report; other parked decisions come to you.
3. The delegate rejected disputes on the same issue twice → **escalate** (deadlock).
4. The number of open issues did not decrease for two consecutive rounds → **escalate** (stall).
5. Otherwise → **continue**.

The thresholds are the `MAX_DISPUTES` and `STALL_ROUNDS` constants. If you change the rules, update the `policy …` tests in `tests/run.mjs` too.

## Build mode: the delegate writes, Claude reviews

```
/agent-duet build                     “delegate to Codex …”, “have Codex implement …”
/agent-duet build --engine agy        “delegate to agy …”, “have agy implement …”
```

1. Claude writes a specification: goal, scope, constraints, acceptance criteria and how to test.
2. The runner creates an `agent-duet/<id>` branch in a separate worktree from HEAD. Your working tree is untouched, and the delegate does not see uncommitted changes.
3. The delegate implements, runs tests, and reports what it did, what it checked and what remains uncertain.
4. Claude reviews the round's diff, runs the tests in the worktree itself, and raises issues C1…Cn. The delegate fixes or disputes them. The [stop policy](#stop-policy-scriptspolicymjs) is the same as in a review; deadlocks come to you (and to the `/duet` pane).
5. When everything is agreed and you approve, `finish` commits the work on the branch and removes the worktree; you merge the branch yourself. A title in Conventional Commits form (`feat: …`, `fix(scope)!: …`) becomes the commit subject as written; any other title gets the `agent-duet: ` prefix unless it already has it. The commit body names the engine that implemented the work and credits Claude's review. `discard` deletes both the worktree and the branch.

Both commands check that the registered worktree is on the build branch at the expected commit. After a stopped or failed turn exits, you can choose `discard` or `finish --unreviewed`. Discard refuses finished and previously discarded builds.

If the build branch has moved, `finish` (including `--unreviewed`) and `discard` stop. In the build worktree, inspect the commits with the printed `git log --oneline <base>..<branch>` command. You can finish the branch by hand. To continue with the runner, save the current tip on another branch, run `git reset --soft <base>` in the build worktree, and rerun the original command. The soft reset preserves the index and working files.

Changes made after approval come back as a new review round; see [Verification and integrity checks](#verification-and-integrity-checks). Instructions for Claude are in `references/build.md`.

## Audit mode: the delegate checks without changing anything

```
/agent-duet audit                     “audit this with Codex …”, “have Codex check … and report back”
/agent-duet audit --engine agy        “audit this with agy …”
```

A one-off report without negotiation: audit code, data, a reference document or a policy, without Claude spending tokens on answering every finding. Review mode fits poorly when Claude may not change the subject on its own, such as a reference document that changes only with your approval: almost every finding would come back to you. Build mode does not fit either, because an audit must not change anything.

1. Claude writes the task: what to examine, which question to answer, the scope, what counts as a finding, and what goes into the notes (a ranking or a table).
2. The delegate works in the project directory, always in `read-only` mode: the runner refuses any other `--sandbox`. Codex applies its read-only shell sandbox. agy has no enforced read-only mode: it denies `write_file`, and the runner checks the files after the turn and warns about changes without undoing them, but shell commands can still write. MCP writes are forbidden only by the prompt, with either engine; see [Security](#security).
3. One turn produces a summary, findings A1…An (severity, location, evidence, recommendation, confidence), and what was and was not checked. Claude's summary gives one line per finding; everything else is in the session's `report.md`.
4. There is nothing to answer: `reply` and `review` refuse an audit. For another angle, start a new audit with a sharper task. Findings remain the delegate's claims: before relying on one, Claude checks it or tells you it is unverified.

The queue, the `/duet` pane (summary and findings), 12-hour turns and `retry` work as in the other modes.

## Long turns, retries and parallel tasks

**Timing.** Delegate turns take long, builds above all, so Claude runs `start`, `reply`, `review` and `retry` in the background with `timeout: 43200000` (12 hours). Claude Code caps background commands at `max(2 hours, BASH_MAX_TIMEOUT_MS)` and silently cuts any longer timeout to that cap; [Installation](#allow-12-hour-background-commands-recommended) shows how to raise it to 12 hours. Without an explicit `timeout`, a foreground command lasts 2 minutes and a background one 30 minutes. The runner itself sets no limit per turn unless you pass `--timeout-min N`. Sessions started before 0.6.0 keep their old 60-minute limit; remove it with `retry --timeout-min 0` (or with `reply`/`review`).

**Interrupted turns.** In any round, `retry` sends the full prompt and feedback again if the delegate never acknowledged them. It uses the existing conversation when available. Once delivery is confirmed, a short prompt continues the interrupted turn. For agy, `init` identifies the conversation. A `user_input` step or a later step confirms delivery. A resumed code review still covers its original snapshot. Codex can use a `.jsonl` or `.jsonl.zst` thread log in `~/.codex/sessions`. agy uses `--conversation` with its saved `.db`. If the conversation is missing, or you choose `retry --fresh`, the runner opens a new one and restores the task, issue ledger and current feedback for later rounds. Files already written stay on disk.

**Several tasks at once.** You can delegate several tasks; every build gets its own worktree and branch. At most ten delegate turns run at once on the machine (`AGENT_DUET_MAX_PARALLEL`); the rest wait in order in the queue (phase `queued`) and start by themselves when a slot frees up. Each running turn starts every MCP server in its engine's configuration, so ten tasks without a queue can mean hundreds of processes. A slot is held only while the delegate works, not while Claude reviews. Time in the queue counts toward the background command's time limit (2 hours by default, 12 with the recommended setting), so prefer a few tasks at a time over dozens.

## Verification and integrity checks

The runner checks what both sides claim, so the result does not rest on their word alone.

**Your request.** For `plan`, `code` and `file` reviews, Claude passes a Markdown brief (`start --brief <file|->`) with three sections: `## Owner's request` (your words, verbatim; required), `## Accepted amendments` (only changes you accepted, each with its source) and `## Claimed result` (what the author of the work says it achieves). A build specification must contain the request itself and may list amendments; it takes no separate `--brief`. An audit takes no brief. The delegate, and Claude before approving a build, each report a `request_check`: whether the work matches your request. A narrowing that the delegate reports in a review, or a disagreement between the two in a build, comes to you. Summaries, `status` and the report show both checks.

**Approval is tied to the reviewed tree.** `finish` checks the worktree before committing and checks the commit and worktree again after hooks run. Changed files, including new files left by hooks, go back for review with the finish commit undone. On your explicit instruction, `finish --unreviewed` records the override in the commit and report, even for an empty change. Before a manual code-review commit, run `verify`. It accepts no staged changes or any subset of the reviewed files. The working tree and each staged change must match the approved snapshot. The output lists remaining reviewed changes as `not staged` and flags any `unapproved staged content` to correct before committing. If working files changed, use the printed `reply` command for another review. Paths are labeled `covered`, `edited-after-review` or `never-reviewed`. After a build finishes, `verify` checks its branch and reports if it has been deleted.

**Quotes in issues.** Each issue quotes the lines it is about. Before a round is recorded, new or changed quotes on open issues are checked against the reviewed snapshot and marked `ok`, `moved:<L>` (found at line L), `other_file:<F>` (found in file F), `MISSING` or `unchecked`. Closing replies and unchanged quotes keep their earlier mark. Summaries and prompts show quote problems, the report keeps the marks, and `/duet` flags missing or other-file quotes on open issues only. A mark never closes an issue or changes the stop decision; `MISSING` asks for a fresh quote and does not dismiss the issue.

**Verification receipts.** In reviews and builds, DONE carries a verification label. Behind it is a *verification receipt*: the runner compares the commands the delegate says it ran with the command events saved from its turn, and shows outcomes, skips with reasons, unconfirmed or contradicted claims, and gaps in the summaries, `report.md` and `/duet`. The labels are `executed` (all checks confirmed, no skips or gaps), `partial` (some confirmed, coverage incomplete), `static-analysis-only` (none confirmed) and `unknown` (an older reply without a receipt). A confirmed failure can still be `executed`. The label never changes the stop decision and does not include the checks Claude runs itself when reviewing a build.

## The `/duet` pane and safeguards

The module reads the session files every 2 seconds and shows the review that belongs to **this** Claude session: the runner records the calling session (`CLAUDE_CODE_SESSION_ID`) and updates it on every turn. If you continue a review from another session, the first `reply` or `retry` moves it there. Reviews owned by another session appear only in the `/duet` pane, labeled and without decision buttons; they produce no band, footer, toasts or sounds. Reviews started before 0.6.0 have no owner and are visible everywhere, as before.

| Surface | Contents |
|---|---|
| **Pane** (`/duet`) | Everything about the session; see the list below |
| **Status band** above the prompt, and the status line | Phase, timer, current delegate action; other modules' bands stay below it |
| **Footer** | A label such as “Duet r3 ⏳ 4:12”; click it to open the pane. Visible even when the band is turned off |
| **Toasts** | Round start and end, escalation, failure; after a round, a “continue agent-duet” suggestion (Tab) |
| **Sound** | Escalation (your decision is needed), review completion, round failure, or a missing delegate process; Claude's own turns make no sound. Uses the Claude app's built-in sounds `tool_approval_needed`, `enter_voice_mode` and `disconnected`, played by the app rather than copied into the plugin. Without the app, fallback sounds from `sounds/` play |

Each live Claude session carries its own selected task, pending choices and expanded issues over from codex-duet once. Saved settings apply across sessions.

The pane, from top to bottom:

- **Task list**, when there are several tasks: ⏳ running, ⏸ queued with its position, 🙋 needs you, ✅ done, with timer and model. Click a row for details.
- **Status**: phase and round timer; model and effort, with ⚡ Fast only on Codex turns that use it; “Now: …” with the delegate's current command, or “thinking for N min” when its event stream has been quiet for more than two minutes, plus how long ago its conversation log was updated, when known (Codex's thread log can keep growing while it thinks silently).
- **Verification** shows the command and exit code of an outstanding confirmed failure, even when every check ran and the receipt says `executed`. A later confirmed pass for the same command clears that warning.
- **The delegate's words**: its latest message in full, rendered as Markdown (paragraphs, lists, `code`), with its age if older than two minutes; its actions (“runs tests …”, “runs a Python script”); its plan.
- **On escalation**, the pane shows the reason. For disputed issues, choose a side and send the decisions to Claude. For a disagreement about the request with no open issues, read each side’s recorded assessment.
- **Issue board**: ● open, ⏸ parked, ✓ fixed, ↩ withdrawn, ⚔×N disputes, and a ▰▱ bar of closed issues out of all (N/M). Titles wrap instead of being cut off; ▸ expands both sides' statements; closed issues stay collapsed while any are open.
- **The scoreboard** counts an owner’s ruling on a build issue separately from a reviewer’s concession. Round history and Settings follow.

Pane text wraps to fit; only task-list rows and delegate commands are truncated.

### Keeping the loop going

The reminder and the context summary cover every active task this Claude session drives, even after hundreds of newer sessions. If a session is waiting for Claude (to answer issues, or to review a build round) and Claude ends its turn, the module sends Claude back to the loop once, through the `Stop` hook. The reminder stays quiet in these cases.

- Claude has asked you a question. The hook recognizes both `?` and `？`, including when Markdown, quotes or brackets follow the question mark.
- You sent a message and Claude answered it without touching the loop.
- A background task is running or a session wake-up is scheduled.
- The session is waiting for your decision (escalation).
- Claude has just been sent back to the loop.

### Git write guard

The guard helps prevent accidental Git writes by Claude. It covers every code review and build in an active phase whose ledger was updated within the last 12 hours. From any Claude session it blocks `git commit`, `push` and `stash` in the reviewed repository or build worktree. Symlinks, including the old `codex-duet` name for a migrated worktree, resolve to the same directory.

- **Recognized:** quoted paths, `cd`/`pushd`, Git global options, environment assignments, command wrappers, compound commands, substitutions, `eval`, shell `-c`, and heredocs or here-strings fed to a shell. The guard follows alternative paths through `&&`, `||`, `if` and `case`, directory-stack rotations such as `pushd +1`, exported Git paths, `env -S`, `git --attr-source` and shell options such as `+o` and `-c --`. When both a Git directory and a work tree are given, a write is blocked if either is in a guarded tree.
- **Blocked to be safe:** a Git write whose directory depends on variables, substitutions or globs, whenever any session is guarded. If parsing fails (for example, on excessive nesting), any command containing the word `git` is blocked while a session is guarded; other commands pass.
- **Allowed:** quoted mentions, comments, data heredocs, `stash list` and `stash show`.
- **Not recognized:** Git aliases (`git ci`, `git -c alias.x=commit x`), scripts and Makefiles that commit (`sh release.sh`, `npm run release`), and other commands assembled at run time.

### Context after compaction

Your messages in the reviewed project get a session summary attached, so Claude does not lose the loop after context compaction. Background task notifications do not get it: the runner's output already contains everything. The summary and the loop reminder work only in the Claude session that owns the review.

### Pane commands

`/duet` opens the pane. The Stop button and `/duet stop` stop the selected running or queued round. Before sending TERM, the module checks the Claude session and the selected attempt. It uses `ps` to verify the runner command and start time for the PID in the session lock. A PID can still be reused between that check and the signal. If the host cannot verify the process identity, Stop explains why it refused. Resume a stopped round with `retry`. Use `/duet band|toasts|score|sound on|off` or the Settings buttons to toggle interface features. Use `/duet sound test` or “▶ Sounds” to play the three sounds in turn. The module never writes session files; it only leaves a one-line `.ui-trace.json` trace for debugging.

## Engine differences

| Capability | Codex | agy |
|---|---|---|
| Models and effort | Default in `~/.codex/config.toml`; checked against `~/.codex/models_cache.json` | Families and levels from `agy models`, usually `--model gemini-4-carbon --effort high`; level names `low`, `medium`, `high`, `xhigh`, `max`; default in agy's `settings.json` |
| `inherit` | Uses your Codex permissions | Adds no permission flags; uses your agy permissions |
| `workspace-write` | Codex workspace sandbox | `--sandbox` with proceed-in-sandbox settings |
| `danger-full-access` | Codex full access | `--dangerously-skip-permissions` |
| `read-only`, including every audit | Codex read-only shell sandbox | A promise plus a file check after the turn; shell writes are still possible |
| Resume | Existing thread log under `~/.codex/sessions` | `--conversation <id>` while the conversation `.db` exists in agy's home |
| Logs | `round-N.events.jsonl` | Raw `round-N.agy.jsonl`, normalized `round-N.events.jsonl` |
| Fast | See [Fast (Codex only)](#fast-codex-only) | None |

### Choosing an agy model

Usually pass a family and a level: `--model gemini-4-carbon --effort high`. agy names each model-and-level pair with a *slug*, such as `gemini-3.8-flash-low`; `agy models` lists them. Slugs, display names and family names are accepted in any letter case.

- **A family** (`gemini-4-carbon`) accepts only the levels `agy models` lists for it. A family without `--effort` lets agy choose the level.
- **A slug** (`gemini-3.8-flash-low`) fixes the level. The same `--effort low` is allowed; a different level is refused with advice to pass the family instead. Changing only `--effort` on `reply`, `review` or `retry` replaces the level of a stored slug.
- **`--effort` alone** applies to the family of the model in agy's `settings.json`.
- **A model without levels** gets `--effort` passed through as is, with a note: how agy treats it has not been tested.

The runner fetches `agy models` at most once per call, with a 15-second timeout. If the catalog is unavailable, or, for an effort-only choice, the `settings.json` model is missing or unknown, the affected check is skipped with a note; the five level names are still validated. The summary, the round record and the pane show the resolved slug and mark a family taken from `settings.json` separately from a level you chose. For a family alone, agy's start event (`init`) reports the slug it picked. Without a catalog, the display keeps your choice as given rather than inventing a slug.

`AGENT_DUET_AGY_HOME` tells the plugin where to read agy's settings and conversation logs (default `~/.gemini/antigravity-cli`). It does not redirect agy itself: set it to the directory agy actually uses. Sign-in keeps your real `HOME`.

### Choosing a Codex model

`--model` and `--effort` default to `~/.codex/config.toml`; plain language works too, such as “delegate to Codex, Astra model, max effort”. The runner checks the choice against your model cache (`~/.codex/models_cache.json`) and refuses to start, listing the available choices, if:

- the model does not exist (use an ID such as `gpt-6-astra` or a name such as `GPT-6-Astra`);
- the effort level does not exist;
- the model does not support that level, including the default from `config.toml`.

Without a cache, the check is skipped. The `Model:` line in the round summary shows what the session uses.

### Fast (Codex only)

There is no separate flag: Codex takes its speed mode from `config.toml` (`service_tier = "priority"`, which the model catalog calls Fast). The ⚡ icon in the status band, the task list and the pane (“Model: … · ⚡ Fast”) appears only when the turn is known to use Fast. “(from config)” means Fast is enabled in the configuration and the catalog offers it for that model; the qualifier disappears once Codex records the turn's mode in its thread log (a `thread_settings_applied` entry in `~/.codex/sessions/…/rollout-…-<thread>.jsonl`). If the log reports the standard mode, the icon disappears. Codex 0.160 writes this entry at the start of every resumed turn, but the first turn of a new thread may lack it. agy has no Fast mode.

## Language

The plugin's `language` setting is `auto` (the default), `en` (English), `ru` (Russian) or `zh` (Simplified Chinese). It covers the plugin's interface and the notes and messages it sends to Claude; the runner's output stays in English. The module reloads when the setting changes.

To set Russian from a shell:

```bash
echo '{"language":"ru"}' | claude plugin configure agent-duet --values-stdin
```

Replace `ru` with `en`, `zh` or `auto` as needed. `--values-stdin` reads a JSON object of single-line strings; options left out keep their current values. Without `--values-stdin`, `claude plugin configure agent-duet` only shows the configuration. You can also change the language in the plugin's row of the `/plugin` menu.

**How `auto` picks a language.** It takes the first nonempty variable among `LC_ALL`, `LC_MESSAGES` and `LANG`, in that order: a value starting with `ru` selects Russian, one starting with `zh` selects Chinese, anything else selects English. Only when all three are unset or empty does macOS fall back to the first preferred language in `AppleLanguages`, with the same mapping. Other platforms, an empty list or a failed lookup give English.

## Security

- Each engine works with its usual setup: your configuration, model, effort, configured MCP servers and the other tools available to it.
- `--sandbox inherit` uses the engine's own permissions. For Codex, an explicit mode applies on every turn: `-s` at start and `-c sandbox_mode=…` on `resume`, because `resume` has no `--sandbox` flag. agy's mappings are in [Engine differences](#engine-differences).
- **agy's read-only is a promise plus a check after the turn, not an enforced sandbox.** It denies `write_file`, but shell commands can write. Before and after each read-only turn, the runner fingerprints tracked and untracked non-ignored files under the working directory in a Git repository; outside Git, it scans a capped set of files. It records and warns about detected changes without undoing them. Ignored files, paths outside the working directory, files beyond the cap, and changes reverted before the check can go unnoticed. The check cannot make untrusted code safe to run.
- **The bans on changing files during a review, on committing and on changing external systems are prompt instructions.** For external PRs or downloaded files, choose `--sandbox read-only`: with Codex this gives its shell sandbox; with agy, only the promise and check above.
- **Do not rely on a shell sandbox to restrict MCP tools.** A delegate may have MCP tools that write to external systems, such as a production database. The prompt forbids changes through any tool, but that is an instruction, not enforcement.
- **macOS keychain dialogs when a program runs with a temporary `HOME`.** Tests and smoke runs sometimes start a program with `HOME` pointed at a temporary directory, for example `claude -p` started by the Claude session overseeing a build. Programs that sign in through the keychain (`claude`, `gh`, git credential helpers, `security`) cannot find it there, and every attempt opens a “keychain not found” dialog that stays open until dismissed. **Click Cancel:** “Reset to Defaults” creates a new, empty keychain in place of yours. Linking `~/Library/Keychains` into the temporary `HOME` removes the dialogs but hands the program your whole keychain, whose entries can then be changed through `securityd`. That is why the delegate's prompts (build and review) and Claude's rules in `SKILL.md` require credentials through the environment, `CLAUDE_CODE_OAUTH_TOKEN` (created with `claude setup-token`) or `GH_TOKEN`, and tell the agent to ask you when none are available.

## File layout

| Path | Purpose |
|---|---|
| `.claude-plugin/` | `plugin.json`: plugin manifest; `marketplace.json`: the single-plugin marketplace used for installation |
| `SKILL.md`, `references/protocol.md`, `references/build.md` | Instructions for Claude |
| `README.md`, `README.ru.md`, `README.zh-CN.md` | Documentation in English, Russian and Simplified Chinese |
| `scripts/duet.mjs` | Runner: engine calls, issue ledger, snapshots, output |
| `scripts/policy.mjs` | **Your** `decideNextStep` stop policy |
| `prompts/`, `schemas/` | Delegate prompts and response JSON schemas |
| `hooks/register.tsx`, `types/index.d.ts` | Module: pane, band, footer, toasts, sound, loop reminder, commit guard, context summary |
| `hooks/locales/en.ts`, `hooks/locales/ru.ts`, `hooks/locales/zh.ts` | Interface and session-message translations; English defines the set of keys |
| `sounds/` | Fallback sounds for when the Claude app is unavailable; `node sounds/make.mjs` synthesizes them again |
| `tests/` | `run.mjs`: runner and policy; `mod.mjs`: the module on a stand-in for Claude Code's plugin runtime; `pane.test.tsx`: the pane rendered through Claude Code's own plugin test kit |
| `~/.local/state/agent-duet/<id>/` | Sessions: `state.json`, prompts and replies for each round, `report.md` |

To reopen the delegate's conversation, use `codex resume <thread id>` for Codex or `agy --conversation <conversation id>` for agy; the report contains the ID. Each round's normalized events are in `round-N.events.jsonl` (used for verification and the pane), and agy's raw output is in `round-N.agy.jsonl`. Parsed replies from both engines keep the compatibility name `round-N.codex.json`; session IDs and internal state fields are unchanged.

## Environment variables

Use the `AGENT_DUET_*` names below. The old `CODEX_DUET_*` names still work; when both are set, the new one wins, even if it is empty. Codex's own `CODEX_HOME` and `~/.codex` are unchanged.

| Variable | Purpose |
|---|---|
| `AGENT_DUET_ENGINE` | Default engine at start: `codex` or `agy` (default `codex`) |
| `AGENT_DUET_MODEL`, `AGENT_DUET_EFFORT` | Default model and effort |
| `AGENT_DUET_TIMEOUT_MIN` | Limit per delegate turn in minutes (default 0, unlimited) |
| `AGENT_DUET_TIMEOUT_MS` | Overrides the per-turn limit in milliseconds (mainly for tests) |
| `AGENT_DUET_KILL_GRACE_MS` | Grace between SIGTERM and SIGKILL, or between exit and pipe closure (default 5000 ms) |
| `AGENT_DUET_MAX_PARALLEL` | Concurrent delegate turns on the machine (default 10); the rest wait in the queue |
| `AGENT_DUET_QUEUE_POLL_MS` | Queue polling interval (default 3000 ms) |
| `AGENT_DUET_SANDBOX` | Default sandbox (`inherit`) |
| `AGENT_DUET_HOME` | Session storage, used as given; default `$XDG_STATE_HOME/agent-duet` or `~/.local/state/agent-duet` |
| `AGENT_DUET_POLICY` | Alternate policy file (used by tests) |
| `AGENT_DUET_CODEX_BIN` | Codex binary (default `codex`) |
| `AGENT_DUET_AGY_BIN` | agy binary (default `agy`) |
| `AGENT_DUET_AGY_HOME` | Where the plugin reads agy's settings and logs (default `~/.gemini/antigravity-cli`); does not redirect the CLI or change `HOME` |

## Upgrading from codex-duet

The plugin was called codex-duet up to 0.12.0. Everything carries over without manual steps:

- **Sessions.** On the first runner call, the old default state directory (`…/codex-duet`, usually `~/.local/state/codex-duet`) moves to the new default (`…/agent-duet`), and a symlink at the old path keeps old absolute paths working, such as those of running processes and of old builds' worktrees. If both directories exist, only the new one is used. A home set explicitly with `AGENT_DUET_HOME` or `CODEX_DUET_HOME` is never moved. The module only reads these paths, and its debug trace (`.ui-trace.json`) stays beside the sessions.
- **Environment variables.** The `CODEX_DUET_*` names still work; see [Environment variables](#environment-variables).
- **Branches.** Build branches named `codex-duet/<id>` are still recognized; new ones are named `agent-duet/<id>`.
- **Pane state.** Claude Code keeps the module's state across hot reloads. Your preferences, the selected task, decisions picked on the pane and expanded issues are imported from codex-duet once; agent-duet's own preferences take precedence.
- **Language.** The language saved for codex-duet is used until you configure agent-duet, including setting an explicit `auto`.

## Troubleshooting

### agy (tested with 1.5.7)

- **No output while starting.** agy waits for all configured MCP servers to connect before working. Check VPN and network access, and run `agy mcp list` with the same agy configuration: one unreachable server can hold up the turn. The queue and the background timeout still apply.
- **A tool is denied.** A headless turn cannot ask you for permission. Configure the needed allow rules in agy, or explicitly choose `--sandbox danger-full-access` (`--dangerously-skip-permissions`). `workspace-write` uses `--sandbox` with proceed-in-sandbox settings; it does not override every tool rule.
- **Retry starts over.** Check that the saved conversation `.db` is still in `AGENT_DUET_AGY_HOME` (default `~/.gemini/antigravity-cli`). `retry` uses `--conversation` only when it is there; `--fresh` restarts on purpose.
- **Read-only violation.** Inspect the recorded paths and the files before going on. The check warns after the turn and never rolls changes back. It cannot catch every write; see [Security](#security).

### Codex CLI pitfalls (0.159)

- `codex exec` waits for EOF on stdin when stdin is not a terminal, and hangs silently. The runner sends the prompt through stdin and closes it.
- `codex exec resume` does not accept `--sandbox`, `--cd` or `--color`.
- `-c 'mcp_servers={}'` does not disable MCP: values are merged, not replaced.
- `codex mcp list --json` prints server environment variables **unmasked**, including tokens.

## Development

Claude Code loads a clone in `~/.claude/skills/agent-duet` by itself, without installation. Claude Code names plugins `<name>@<source>`: this one is `agent-duet@agent-duet` when installed from this repository's marketplace, and `agent-duet@skills-dir` as a clone in `~/.claude/skills`. Changes apply to new sessions. Do not also install the plugin from the marketplace: an installed plugin takes precedence over a skills-dir plugin of the same name, and the clone then shows as “Not loaded”.

## Tests

```bash
node tests/run.mjs
node tests/mod.mjs
claude plugin test .
claude plugin validate .
```

Run these from the plugin directory. `run.mjs` and `mod.mjs` also run in GitHub Actions (`.github/workflows/tests.yml`) on macOS and Linux.

`run.mjs` tests the runner with a fake Codex (`tests/fake-codex.mjs`): the ledger, disputes, escalation, `retry`, read-only on `resume`, diffs between rounds and the policy's English reasons. It also runs the verification and compatibility suites and the agy suite on a fake agy (`tests/agy.mjs`); the agy suite also runs on its own with `node tests/agy.mjs` and needs neither a real agy nor the network.

`mod.mjs` transpiles the real `hooks/register.tsx` and its local static imports, then runs its hooks against a stand-in for Claude Code's plugin runtime (`tests/mod-engine.mjs`). `duet.mjs` creates the sessions with the same fake Codex. The tests cover the pane, band, footer, toasts, sound, loop reminder, commit guard and context summary, including English by default, explicit Russian and Chinese, locale priority in `auto`, the macOS preferred-language fallback and English on lookup failure, translated session messages and decisions, and matching keys across the three locale tables. Transpiling needs esbuild (the copy bundled with a global `tsx` works) or `typescript`; set its path through `ESBUILD` or `TYPESCRIPT`. The stand-in catches logic errors but not misunderstandings of the plugin API: check new API calls against `claude-code.d.ts` and `claude plugin validate`. The idea comes from plan-progress ([zycck/claude-mods](https://github.com/zycck/claude-mods)).

`tests/pane.test.tsx` renders the pane through Claude Code's own plugin test kit (`claude plugin test`) on the terminal, desktop and mobile surfaces in English, Russian and Chinese. Each surface's component registry validates the tree, which the stand-in cannot do. The review session lives in test memory. The tests check that long titles and the label for another session's review are fully visible, that issues expand, and that the delegate's words render as Markdown; the narrow 44-column layout also checks wrapping with double-width Chinese characters.

## Disable or uninstall

```bash
claude plugin disable agent-duet@agent-duet
claude plugin uninstall agent-duet@agent-duet
```

A clone in `~/.claude/skills` is disabled the same way with `agent-duet@skills-dir`; delete its directory to uninstall it.

## License

MIT; see [LICENSE](LICENSE).
