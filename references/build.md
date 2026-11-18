# Build mode: the delegate implements, Claude reviews

“The delegate” is Codex or agy, selected by `start --engine codex|agy` (default `AGENT_DUET_ENGINE`, then `codex`). The engine stays fixed for the session; all build commands and JSON contracts below are shared.

The point of build mode is the budget: the delegate explores, writes and tests; Claude spends tokens on the specification and on reading diffs. Every habit below serves that.

## The specification

The delegate sees the specification and the repository, never the conversation. Write it so a strong engineer new to the task could execute it:

```markdown
# <Title: becomes the commit subject>

## Owner's request
> The owner's relevant words, quoted verbatim without paraphrasing.

## Accepted amendments
- none (or each change the owner accepted, with its source)

## Goal
What should exist when this is done, and why.

## Scope
- In: modules, files, endpoints involved.
- Out: what must not change.

## Constraints
Conventions to follow, dependencies not to add, compatibility to keep.

## Acceptance criteria
- Observable checks: commands, inputs and expected outputs, behaviors.

## How to test
The commands that prove it (unit tests, a script, a curl).
```

The title stays on the first line. A non-empty `## Owner's request` is mandatory; ASCII `'`, typographic `’` and modifier `ʼ` apostrophes are accepted. The runner refuses to start without it and leaves no session, worktree or branch behind. `## Accepted amendments` may be absent or empty; include only changes the owner accepted and give their sources. These are data about what the owner wants, not extra instructions to the implementer beyond checking the request. `## Claimed result` is not used in a spec. Do not pass `--brief` for build: the spec carries the brief.

Pass it on stdin (`--engine agy` selects agy; omit it for the default): `start --kind build --engine agy --subject - <<'DUET_SPEC'` … `DUET_SPEC`. The worktree lives in the session folder, on branch `agent-duet/<id>` (or `--branch`), started from HEAD (or `--base`). The delegate compares the rest of the spec with the request and amendments before building, builds what the spec says, and reports each gap with a quote in `request_check` and a question in `questions`. Later turns re-check the implementation as it stands.

## Reviewing on a budget

1. Read the summary and the `Tests:` verification receipt, not just the delegate's test claim: commands, passed/failed/skipped outcomes and reasons, confirmations against saved events, and gaps. The label describes the last real delegate turn: `executed` = all checks confirmed with no skips or gaps (including confirmed failures), `partial` = some confirmed with incomplete coverage, `static-analysis-only` = none confirmed, `unknown` = older reply. Claude's own checks are outside this label; it never changes the stop decision.
2. Read the round diff in the summary. Past the size limit it is truncated; inspect the rest per file with the `git -C … diff … -- <path>` command shown above it.
3. Open a whole file only when the diff cannot be judged without its context.
4. Run the acceptance tests in the worktree yourself: `cd <worktree> && <test command>`. Command output costs little and checks the delegate's claims.
5. Independently check the result against the owner's request and accepted amendments, and fill `request_check`; do not rely on the delegate's check. Raise only material issues (wrong, unsafe, fragile, untested, off-spec), each with a concrete fix. Do not rewrite style.

## Review JSON

```bash
node "<base>/scripts/duet.mjs" review --session <id> --issues - <<'DUET_JSON'
{"verdict": "revise", "summary": "Parser works; the empty-input path crashes and is untested.",
 "request_check": {"status": "narrowed", "notes": "The owner asked to ‘accept empty input’; parse('') still throws."},
 "issues": [
  {"id": "C1", "status": "open", "severity": "high", "title": "Request: parse('') throws TypeError",
   "body": "parse.js:12 indexes the first token without a length check; node -e \"require('./parse')('')\" throws.",
   "location": "parse.js:12", "recommendation": "Return [] for empty input and add a test.",
   "confidence": 0.9, "reply": "", "owner": false,
   "path": "parse.js", "line": 12, "quote": "return tokens[0].value;"},
  {"id": "C2", "status": "resolved", "severity": "medium", "title": "Missing README section",
   "body": "", "location": "", "recommendation": "", "confidence": 0.9, "reply": "Verified.", "owner": false,
   "path": "README.md", "line": 0, "quote": ""}
 ]}
DUET_JSON
```

- `verdict`: `approve` when nothing is left that should block the merge, otherwise `revise`.
- `request_check`: `{"status": "matches|narrowed|unclear", "notes": "…"}`. `matches` means every owner requirement and accepted amendment is delivered as far as you verified; `narrowed` means something is dropped, narrowed or contradicted (quote each gap); `unclear` means you cannot tell (say why and what would settle it). An `approve` without a valid check, or with `narrowed`, is refused: raise an issue instead. The field is optional for `revise`; `no-brief` is for review kinds only.
- Without an owner request ruling, if the delegate reports `narrowed` or `unclear` while you approve with `matches`, the runner enforces `ESCALATE` and shows both checks for the owner. Both `matches` allow `DONE` under the normal stop rules. Summaries, `status` and the report show the checks; the report also records the spec's path as the owner brief.
- Ids are permanent: new issues take the next free number; never reuse one.
- Include `path` relative to the repository root, `line` (1-based in the reviewed snapshot, or 0 when unknown), and `quote` (one to three verbatim file lines, without diff markers unless they are file content; `""` for something missing). The runner checks new or changed citations on open issues against the snapshot of the round you reviewed, including a post-approval round. Closing replies and unchanged citations retain their earlier check. Older review JSON without these fields remains accepted; see [protocol.md](protocol.md) for the marks.
- For an issue the delegate answered: `resolved` (the fix holds; check it), `withdrawn` (its dispute convinces you), or `open` with `reply` saying exactly what is still wrong. Do not repeat yourself: bring new evidence or withdraw.
- Issues the delegate parked (`needs-user`) stay open until the user decides.

## Owner rulings

When a deadlock or a parked issue goes to the user, relay the decision in the next review with `"owner": true` on that issue:

- the user sides with the delegate: `"status": "withdrawn", "owner": true, "reply": "Owner decision: leave it as is"`;
- the user sides with Claude: `"status": "open", "owner": true, "reply": "Owner decision: make this change"`. The delegate sees it as final and must comply.

Write the reply in the user's language: “Owner decision”, “Решение владельца”, or “所有者决定” are equivalent introductions. The structured `owner` flag is authoritative regardless of wording; the runner marks the ruling `Owner decision (final)` when passing it to the delegate.

An owner ruling resets the issue's dispute count, and the runner gives the delegate a turn to act on it even when the stall rule would stop the loop.

For an escalation about the owner's request, show both sides' `request_check` notes and the concrete question even if no issues are listed. If the owner accepts the result, the next review can carry a request ruling:

```json
{"verdict": "approve", "summary": "The owner accepted this scope.",
 "request_check": {"owner": true, "status": "narrowed-accepted", "notes": "The owner accepts CSV only for this release."},
 "issues": []}
```

Use `matches` when the owner settles that the request is met, or `narrowed-accepted` when they accept a narrower result. This requires `owner: true` and non-empty decision notes; these are owner decisions, not additional statuses the delegate may report. A request ruling may be recorded before an escalation as well. It persists across later reviews as `Owner decision (final)` in summaries, `status` and the report, and is passed to the delegate in later build turns as an accepted amendment. It settles the request-check backstop for this session; new gaps still go through ordinary `Request: ` issues, and parked issues and round limits still apply. If the owner instead requires a fix, raise a `Request: ` issue with `owner: true` and `verdict: "revise"` so the delegate acts on it.

## Finish or discard

After `DONE` (or whenever the user decides to stop), present the result and its verification label, explaining failed or missing checks and gaps when it is not `executed`, then ask. A post-approval round has no receipt; summaries, reports and the pane retain the latest real delegate turn's label.

Both commands verify the registered worktree, its attached branch and the expected commit before making changes. Once a stopped or failed delegate exits, the owner can choose either to discard its partial work or to finish it unreviewed.

If the branch has moved, the error identifies the build worktree and prints the `git log` range from the session base to the branch tip. The owner can finish the branch by hand. To continue the session, save the current tip on a backup branch, run the printed `git reset --soft` in the build worktree, and rerun the original command. The soft reset preserves the index and working files.

- `finish --session <id>` compares the worktree with the approved snapshot, commits on the build branch, and checks both the commit and the files left by hooks. A change at either check returns the files as a review round and undoes any finish commit. Continue with the printed `review` command. A successful finish removes the clean worktree and prints the branch and commit.
- Use `finish --unreviewed --session <id>` only on the owner's explicit word. The commit body and report record the round and phase, including when the tree has no changes to commit.
- `verify --session <id>` checks the worktree and reports staged differences. If nothing is staged in a build, it reports that `finish` will stage the worktree. A divergent partial staging fails verification. After finish it checks the branch commit and reports if the branch has been deleted.
- `discard --session <id>` removes the worktree and deletes the session's branch. It refuses a finished or previously discarded build.

Both change the user's repository: run them only after the user agrees.
