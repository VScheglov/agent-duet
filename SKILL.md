---
name: agent-duet
description: Use when asked to have Codex or agy review plans, code or files ("отдай Codex на ревью", "отдай agy на ревью", "пусть Codex посмотрит план/код/файл", "пусть agy посмотрит план/код", "have agy review this", "have agy review the plan/code", "让 Codex 审查代码", "让 agy 审查代码", "让 agy 审查计划"), discuss them ("обсудите с Codex", "договоритесь с Codex"), delegate implementation ("делегируй Codex", "делегируй agy", "пусть Codex реализует", "delegate to agy", "让 Codex 实现", "让 agy 实现"), request an audit ("проведи аудит через Codex", "проведи аудит через agy", "пусть Codex проверит … и даст отчёт", "audit this with agy", "用 Codex 做审计", "用 agy 做审计"), or run /agent-duet plan|code|file|build|audit|status.
argument-hint: "plan | code [--base <ref>] | file <path>... | build | audit | status [--engine codex|agy] [-- focus]"
allowed-tools: Bash(node:*)
---

# agent-duet

Run a multi-round loop between Claude and a delegate engine: Codex by default, or agy (Antigravity CLI). Use `/agent-duet` for the skill and `/duet` for its pane. In this guide, “the delegate” means the engine saved in the session. Each issue is negotiated until they agree, the round limit is hit, or a deadlock needs the user. Two directions, and a one-shot mode:

- **review** (`plan`, `code`, `file`): the delegate reviews, Claude is the author and fixes or disputes each issue.
- **build**: the delegate implements a specification in a worktree of its own, Claude is the architect and reviewer. This spends Claude's budget on the spec and the review only; the delegate does the exploring, coding and testing.
- **audit**: the delegate examines what a task asks about, read-only, and reports findings with evidence in one turn. Nothing is negotiated and the delegate must leave everything unchanged; Claude spends its budget on the task and the summary only.

A script owns the mechanics: delegate turns, the issue ledger, snapshots, the stop rules. Claude owns the judgment.

## Runner

The environment variables below use `AGENT_DUET_*`; the old `CODEX_DUET_*` names remain supported, with the new name taking precedence when both are set.

The runner is `scripts/duet.mjs` in this skill's base directory:

    node "<base directory of this skill>/scripts/duet.mjs" <command> ...

Every call prints a Markdown summary that ends with the exact next command. Run the calls that wait for the delegate (`start`, `reply`, `review`, `retry`) with the Bash tool in the background: `run_in_background: true` and `timeout: 43200000`. For a background call `timeout` is when Claude Code kills it: 30 minutes by default, at most 2 hours unless `BASH_MAX_TIMEOUT_MS` in the user's settings raises it (the README asks for 12 hours), and a larger value is cut to the ceiling without an error. A delegate turn often runs for hours, a build turn above all, and a killed call cancels the round (`cancelled: … SIGTERM`). `retry` resends the full round when delivery was unconfirmed. Otherwise it continues the interrupted conversation against the originally submitted snapshot. With missing conversation data or `--fresh`, it restores the task, ledger and feedback in a new conversation. After launching, wait for the completion notification and read the output. `status`, `list`, `report`, `finish` and `discard` are quick: run them in the foreground. Never start another call for the same session while one is running.

## Start

Parse the arguments: the first word is the mode (`plan`, `code`, `file`, `build`, `audit`, `status`); text after `--` is the focus. For a natural-language request, infer the mode and engine. `start --engine codex|agy` chooses the engine; otherwise `AGENT_DUET_ENGINE` applies, then `codex`. Save it for the session: `reply`, `review` and `retry` cannot change engines. Common options: `--focus "<text>"`, `--max-rounds <n>` (default 10), `--model <name>`, `--effort <level>`, `--sandbox <mode>` (default `inherit`). Model and effort can change on `reply`, `review` or `retry`. For Codex, use its config and model cache; a spoken name maps to its model id («астра, max» → `--model gpt-6-astra --effort max`). For agy, usually pass a family and level: `--model gemini-4-carbon --effort high`. Model slugs, display names and family names are accepted case-insensitively. A slug such as `gemini-3.8-flash-low` fixes its level: a conflicting `--effort` is refused; use the family to choose another level. Family levels are checked against `agy models`; `--effort` alone uses the family of the `settings.json` model. Switching only `--effort` replaces a stored slug's level. Switching only `--model` lets the new model choose its level. A standalone model without levels passes effort through with a note because its behavior is unprobed. The runner fetches the catalog at start or on an explicit model or effort change, with a 15-second limit. Subsequent turns and display commands use the session cache. Missing, unreadable or unknown settings and network failures are reported when they prevent validation. A credential failure stops the call. For a family alone, the conversation transcript records agy's chosen slug. `Model:` and the pane show the resolved slug and distinguish a configured family from an explicit level. Ask the user when validation rejects a choice rather than inventing one. `Model:` shows the chosen settings; `⚡ Fast` is Codex-only.

For agy, require an installed, authenticated CLI (`agy` by default; tested with 1.5.10). `AGENT_DUET_AGY_BIN` selects the binary and `AGENT_DUET_AGY_HOME` selects where the plugin reads agy settings and conversation logs (default `~/.gemini/antigravity-cli`). It does not redirect the CLI: point it at the directory agy actually uses; authentication keeps the real `HOME`. `inherit` adds no permission flags, `workspace-write` uses `--sandbox` with proceed-in-sandbox settings, and `danger-full-access` uses `--dangerously-skip-permissions`. When a completed turn reports a denied action, keep its answer and show the denial. If a denial prevented an answer, explain which tool needs an allow rule. agy waits for every configured MCP server to connect; for a silent start, check VPN/network and `agy mcp list`.

For agy, `read-only` (mandatory in audit) is a promise plus an after-turn check, not an enforced read-only sandbox. Its sandbox denies `write_file`, but shell commands can still write. The runner fingerprints tracked and untracked nonignored files under cwd in git, or a capped set outside git, records detected changes and warns without undoing them. Say this plainly before an agy audit or read-only review; do not describe it as filesystem isolation. `retry` resumes agy with `--conversation` while its `.db` exists; otherwise it restarts. `retry --fresh` always restarts. See README for the engine comparison, logs and limits.

Whenever the owner's request is in the conversation, prepare an owner brief for a **plan**, **code** or **file** review and pass `start --brief <path>` or `--brief -` (stdin). Quote the owner's relevant words verbatim, without paraphrasing. Include only amendments the owner accepted, each with its source; the claimed result is the author's claim, not a fact you have verified:

```markdown
## Owner's request
> The owner's own words about this task.

## Accepted amendments
- none (or each accepted change with its source)

## Claimed result
What the author says the subject achieves.
```

The level-2 English headings are case-insensitive; ASCII `'`, typographic `’` and modifier `ʼ` apostrophes are accepted. `Owner's request` must be non-empty. The other two sections may be absent or empty. The runner stores the document as `brief.md` and sends it verbatim to the delegate, which separately reports `request_check` and raises each narrowing as a `Request: ` issue. A review without a brief remains supported and reports `no-brief`. Stdin carries one document: with `--subject -`, pass the brief as a file. Build carries the request in the spec itself; audit refuses `--brief`.

- **plan**: review the current implementation plan.
  - In plan mode: `start --kind plan --subject <plan file path>`, and edit that file between rounds.
  - Otherwise pass the plan as currently agreed in the conversation on stdin: `start --kind plan --subject - <<'DUET_PLAN'` … `DUET_PLAN`. Between rounds edit the `plan.md` printed on the `Subject:` line.
- **code**: review git changes; run from inside the repository. `start --kind code` covers uncommitted work including untracked files; add `--base <ref>` for the whole branch since its merge-base. Outside git, use `file`.
- **file**: `start --kind file --subject <path> [--subject <path> …]`.
- **build**, **audit**: see below.
- **status** reprints the session for the current directory, including a build found from its source repository or worktree. Use `list` to see all matches and `--session <id>` to choose among them.

Before starting, tell the user in one line what goes to the delegate and that turns take minutes.

## Each round of a review

The `Decision:` line of the summary drives the loop.

- **CONTINUE**: answer every open issue with `fixed` (make the change first), `disputed` (argue with evidence) or `needs-user` (park it for the user), following `references/protocol.md`. Then run the `reply` command shown in the summary. Give the user one short line per round in their language, for example “Round 2/10: the delegate raised 3 issues; fixed C1 and C2, disputed C3.”
- **DONE**: include the verification label next to DONE. If it is not `executed`, tell the owner what failed, was skipped, remains unconfirmed or contradicted, and what was not examined (`unknown` means an older reply has no receipt). Then present the outcome in the user's language: what changed, what the delegate conceded, what remains open, and the report path. Before committing reviewed code, run `verify --session <id>` in the foreground. It accepts no staged changes or any subset of the approved files. Paths marked `not staged` are informational. Correct any `unapproved staged content` and rerun `verify` after changing the index. Send working-tree changes back for review with the printed `reply` command.
- **ESCALATE**: stop. Present each listed issue with both positions side by side and the concrete question to decide; use AskUserQuestion when there are four issues or fewer. Then continue with `reply`: when the user sides with the delegate, make the fix and answer `fixed` with a note in the user's language saying the fix follows their decision; when the user sides with Claude, answer `owner-decided` with the decision. After a round-limit escalation, add `--max-rounds <n>` to `reply` if the user wants more rounds. The user may also decide in the `/duet` pane: the decision then arrives as a localized message beginning with the stable prefix `agent-duet <id>:` and listing their choices; treat it as the user's answer and continue the loop regardless of the message's language.

For a request-check escalation, show the delegate's `request_check` notes and the concrete question even when no issues are listed. If the owner accepts the narrower result or settles the uncertainty, include `"request_ruling": "<the owner's decision>"` in the `reply` payload (`responses: []` when there are no issues); otherwise fix the subject and reply with the change. Only relay an actual owner decision. A non-empty request ruling may be recorded before an escalation too; it persists as `Owner decision (final)`, is passed to the delegate as an accepted amendment, and settles the request-check backstop for this session while ordinary issues and round limits still apply.

## Build mode: the delegate implements, Claude reviews

1. **Spec.** Write a specification the delegate can execute without the conversation: goal, scope and non-goals, constraints, the files or modules involved, acceptance criteria, how to test. Keep the title first (it becomes the commit subject), then a mandatory, non-empty `## Owner's request` quoting the owner verbatim and optional `## Accepted amendments` with sources. A spec without the request is refused before the delegate runs; `--brief` is refused for build, and `## Claimed result` is not used in a spec. The delegate checks the rest of the spec against the request before building, fills `request_check` every turn, and asks about each gap in `questions`. Show the spec to the user in a few lines and start: `start --kind build --subject - <<'DUET_SPEC'` … `DUET_SPEC` (options: `--base <ref>`, `--branch <name>`). The worktree starts from HEAD, so uncommitted work in the user's checkout is not visible to the delegate; say so when the checkout is dirty.
2. **Review.** The summary shows what the delegate did, its verification receipt in the `Tests:` block, the branch diffstat and this round's diff. Read the receipt: confirmed checks match saved command events; failed, skipped, unconfirmed and contradicted checks and gaps need attention. `executed` means all claims were confirmed with no skips or gaps, and may include confirmed failures; `partial` means some checks were confirmed, `static-analysis-only` means none, and `unknown` means an older reply lacks checks. Claude's own checks do not enter this label, and it never changes the stop decision. Review economically: read the diff, open only the files the diff does not explain, run the tests in the worktree. Independently check the implementation against the owner's request and accepted amendments, then send the review with `review --session <id> --issues - <<'DUET_JSON'` (format and examples in `references/build.md`). An `approve` without an owner request ruling requires `request_check: {"status": "matches|unclear", "notes": "…"}`; for `narrowed`, quote each dropped requirement and raise an issue instead of approving. The delegate's `narrowed` or `unclear` against your `matches` escalates to the owner unless they have already ruled. Every issue the delegate answered needs a status: `resolved`, `withdrawn` (its argument holds) or `open` with a reply. The summaries, `status` and report show both checks.
3. **Loop.** `CONTINUE` runs the next delegate turn by itself. `ESCALATE` works as in a review, with the roles swapped: when the user sides with the delegate, withdraw the issue with `"owner": true`; when the user sides with Claude, keep it open with `"owner": true` and a reply describing the owner's decision in the user's language, and the delegate has to comply. The structured `owner` flag makes it final; the runner labels it `Owner decision (final)` for the delegate.
   For a request-check escalation, show both sides' check notes and ask what the owner wants to accept or change, even if there are no issue IDs. To accept the result, send `request_check: {"owner": true, "status": "matches|narrowed-accepted", "notes": "<the owner's decision>"}` in the next review; to require a fix, raise a `Request: ` issue with `"owner": true` and `verdict: "revise"`. The request ruling persists, is shown in summaries, `status` and the report, and reaches the delegate in subsequent turns; it may also be recorded before an escalation, and does not close ordinary issues.
4. **Done.** Present the result with the last delegate turn's verification label; when it is not `executed`, explain the failed or missing checks and gaps. Then ask the user: `finish` commits only the approved content on the branch and removes the worktree (the user merges), `discard` deletes both. Both commands check the registered worktree, attached branch and expected commit. Changes left by hooks, including unstaged and new files, go back for review with the finish commit undone. Continue with the printed `review` command. Once a stopped or failed delegate exits, the owner can choose `discard` or `finish --unreviewed`. `finish --unreviewed` bypasses the approval checks and records that choice in the commit and report: use it only on the owner's explicit word. Never run finish or discard without the user's go-ahead.

**Several tasks at once.** Start each task with its own background `start`; every build gets its own worktree and branch. At most `AGENT_DUET_MAX_PARALLEL` delegate turns run at once on the machine (10 unless the user set it); the rest wait in phase `queued`, in the order they queued, and start by themselves. A queued call still counts toward the time limit of its background Bash call, so prefer independent tasks and a handful at a time. Pass `--session <id>` to every later call. Each finished round arrives on its own; review it on a budget (tests and the diffstat first, the whole diff when the tests fail or at the last round), so several tasks do not spend Claude's limit several times over. Tell the user which tasks touch the same files: their branches will conflict when merged.

## Audit: the delegate examines without changing anything

For a one-off report rather than a negotiation or a change: a code or data audit, a check of a canon or a policy, an answer to «what is wrong with X».

Before an agy audit that may need MCP, check the required per-tool Antigravity grants or explicitly forbid MCP in the task.

1. **Task.** Write what the delegate should examine and answer: the question, the scope (paths, data, systems it may read), what counts as a finding, what to leave out, and anything extra the report should carry (a ranking, a table: it goes to `notes`). Run from the project's directory: audit always selects `read-only` (`--sandbox` other than read-only is refused). Codex applies its read-only sandbox; agy uses the promise and after-turn check described above, which does not prevent shell writes. Start in the background like every delegate call: `start --kind audit --subject - <<'DUET_TASK'` … `DUET_TASK`; several audits may run at once and share the queue.
2. **Result.** One turn. The summary gives the result, one line per finding with its severity and location, and what was covered; the evidence, recommendations and notes are in `report.md`. Present the summary to the user and say where the report is; open the report only for the findings a decision depends on.
3. **Nothing to answer.** `reply` and `review` refuse an audit; for another angle, start a new audit with a sharper task. Findings are the delegate's claims: before acting on one (a change, a ticket), check it against the code, or tell the user it is unverified.

## Rules

- Run `discard --session <id>` on an audit or review only when the owner asks to close it. It refuses a running or queued turn and keeps the session files. For a failed turn, wait for the runner to exit first.
- Never commit, push or stash. Edit only what the subject covers: the plan file, the changed code, the reviewed files. During a code review or a build the plugin also blocks these git commands in that repository or worktree; when the user asks for a commit mid-review, tell them it waits for the review to end, or that they can commit themselves.
- In a build, do not edit the worktree yourself: every change goes through the delegate, or the delegation saves nothing.
- In plan mode edit nothing but the plan file.
- Never satisfy the delegate by weakening tests, deleting checks, swallowing errors or hiding behavior, and do not accept that from the delegate in a build.
- Summarize the delegate for the user; do not paste whole replies.
- Keep the loop going within the turn: after a round's one-line summary, answer the issues and run the next command. When a turn ends while the loop waits on Claude, the plugin sends back a localized reminder beginning with the stable prefix `agent-duet <id>:`; continue the loop regardless of its language, unless the user asked to stop or a question to the user is pending, then end the turn again.
- For code the user did not write (an external PR, downloaded files), start with `--sandbox read-only`. For Codex this applies its sandbox; for agy it remains a promise plus an after-turn check, so do not rely on it to isolate untrusted code.
- When testing on the owner's desktop, never start real agy, claude, gh, Git credential helpers or `security` with a temporary `HOME`. agy 1.5.9+ stores its OAuth token in the macOS keychain and opens Google sign-in in the browser if it cannot reach it. Pin `AGENT_DUET_AGY_BIN` to a fake and use a disposable `AGENT_DUET_AGY_HOME` for tests. Keep the owner's `Library/Keychains` out of test homes. Pass credentials for claude and gh through `CLAUDE_CODE_OAUTH_TOKEN` or `GH_TOKEN`, or ask the user.

## Additional resources

- **`references/protocol.md`**: answering a delegate review: response JSON, when to fix, dispute or park, how to write a dispute, escalation format, recovery.
- **`references/build.md`**: build mode: writing the spec, reviewing on a budget, review JSON, owner rulings, finish and discard.
- **`scripts/policy.mjs`**: the user's stop policy (`decideNextStep`); the script enforces the round limit on top of it.
- **`README.md`**: setup, configuration, storage, troubleshooting.
