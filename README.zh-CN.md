[English](README.md) | [Русский](README.ru.md)

# agent-duet

Claude 与受委托的引擎（默认 **Codex**，也可以是 **agy**，即 Antigravity CLI）自行完成审查、实现或审计，不用在聊天窗口之间复制内容：

- **审查**（`plan`、`code`、`file`）：引擎审查计划、你的 git 改动或任意文件。Claude 对每个问题要么修复，要么用证据提出异议，要么留给你裁决。循环会一直进行，直到双方达成一致、陷入僵局或用完轮次。
- **构建**（`build`）：引擎在独立的 git worktree 中实现 Claude 编写的规格，Claude 以架构师身份审查每一轮。大部分工作消耗的是所选引擎的额度，而不是 Claude 的额度。
- **审计**（`audit`）：引擎检查代码、数据或文档，不做任何修改，给出一次性的发现报告。不进行协商。

全部五种模式都支持两个引擎。可以用 `/agent-duet` 或自然语言开始；`/duet` 打开实时面板查看进度。插件由两部分组成：**运行器**（`scripts/duet.mjs`）负责运行引擎的每一轮并记录每个会话；Claude Code **模块**（`hooks/register.tsx`）负责绘制面板、状态条和通知，并添加循环钩子和提交保护钩子。运行器由 Claude 代你执行。

> 0.12.0 及更早版本名为 **codex-duet**。会话、偏好、环境变量和 `codex-duet/` 分支会自动沿用；详见[从 codex-duet 升级](#从-codex-duet-升级)。

## 安装

### 要求

- Claude Code 2.1.275 或更新版本。
- 已安装并登录的引擎：[Codex CLI](https://github.com/openai/codex)，且 `codex` 在 `PATH` 中；或 agy（Antigravity CLI，已用 1.5.10 测试），且 `agy` 在 `PATH` 中。如需使用其他可执行文件，设置 `AGENT_DUET_CODEX_BIN` 或 `AGENT_DUET_AGY_BIN`。
- Node.js 22 或更新版本：运行器是一个 Node 脚本。
- code 和 build 模式需要 git。

### 平台支持

| 平台 | 支持情况 |
|---|---|
| macOS | 全部功能 |
| Linux | 除声音外的全部功能：Linux 上的 Claude Code 没有音频播放器，但通知和状态条仍可用。如果运行器被 `kill -9` 终止或机器崩溃，请手动删除遗留的会话锁；`stale lock` 错误会给出文件路径。（在 macOS 上，内核会自动释放这类锁，即 `O_EXLOCK`。） |
| Windows | 不支持：运行器和模块会调用 `kill`、`tail`、`head`、`grep` 和 `diff`。WSL 应与 Linux 表现相同，但尚未测试 |

如果你的组织通过 managed settings 管理 Claude Code，你自行安装的插件不会运行 `Stop` 钩子，因此 Claude 结束一轮后，模块无法把它带回循环（见[循环不会自行停下](#循环不会自行停下)）。其他功能均可使用。

### 安装插件

在 Claude Code 终端会话中运行：

```
/plugin install agent-duet --marketplace VScheglov/agent-duet
```

遇到 `Add marketplace?` 时回答 `y`，然后选择作用范围：选择 user 后，插件可用于所有项目。在 shell 中的等效命令：

```bash
claude plugin install agent-duet --marketplace VScheglov/agent-duet
```

在不支持 `/plugin` 的 Claude 应用中：点击输入框旁的 **+**，依次选择 **Plugins**、**Add marketplace**，输入 `VScheglov/agent-duet`，再选择 **Add plugin**。

如果安装后看不到 `/agent-duet` 和 `/duet`，请新建会话或执行 `/reload-plugins`。技能命令的完整名称是 `/agent-duet:agent-duet`；只要没有其他命令占用这个名字，简写 `/agent-duet` 就能使用。

### 将后台命令时限设为 12 小时（推荐）

引擎的一轮可能持续数小时，因此 Claude 以后台命令运行它，并设置 `timeout: 43200000`（12 小时）。如果不调整配置，Claude Code 会把后台命令限制在 2 小时，较长的一轮会被中断；这时可以让 Claude 执行 `retry`，它会尽可能恢复与引擎的同一段对话。要提高上限，在 `~/.claude/settings.json` 中加入：

```json
{ "env": { "BASH_MAX_TIMEOUT_MS": "43200000" } }
```

此设置对修改后新开的会话生效，同时也会把前台命令允许的最长超时提高到 12 小时。

## 使用

```
/agent-duet plan                      审查 plan mode 或当前对话中的计划
/agent-duet code                      审查未提交的改动（包括 untracked 文件）
/agent-duet code --base main          审查从与 main 的 merge-base 起的整个分支
/agent-duet file docs/spec.md         审查任意文件：测试用例、SQL、规格、配置
/agent-duet build                     让引擎在独立 worktree 中实现任务
/agent-duet audit                     一次性只读审计，输出发现报告
/agent-duet code -- 检查迁移          `--` 后面的文字是本次重点
/agent-duet code --engine agy         用 agy 代替 Codex（适用于任何模式）
/agent-duet status                    当前进度（压缩上下文后也适用）
/duet                                 打开实时面板
```

也可以直接说：“让 Codex 审查代码”“让 agy 审查代码”“让 agy 实现”“用 agy 做审计”。

**谁来运行命令。** 你只需与 Claude 对话，Claude 通过运行器的子命令推进会话：`start`、`reply`、`review`、`retry`、`verify`、`finish`、`discard` 和 `status`。本文提到这些子命令时，都由 Claude 替你运行：直接提出要求即可，例如“重试中断的那一轮”或“完成 build”。

在源仓库或 build 的 worktree 中运行 `list` 即可找到对应的会话。如果有多个匹配项，请用 `--session <id>` 指定 `status`、`verify` 等命令要操作的会话。

**引擎**在会话开始时用 `--engine codex|agy` 选择。省略时先取 `AGENT_DUET_ENGINE`，再默认为 `codex`。会话会固定使用所选引擎：`reply`、`review` 和 `retry` 都不能更换，要换引擎请新建会话。0.12.0 之前的会话没有引擎字段，仍按 Codex 会话处理。

**两个引擎通用的选项：** `--max-rounds N`（默认 10）、`--model`、`--effort`、`--timeout-min`（每轮时限，默认不限制）和 `--sandbox`（默认 `inherit`）。`reply`、`review` 和 `retry` 可以更换模型或推理级别。各引擎如何理解这些选项，见[引擎差异](#引擎差异)。

## 协商过程

```
start ─► 引擎：问题 C1…Cn（符合 schema 的 JSON）
          │
          ▼
   Claude 逐项回复：fixed · disputed · needs-user
          │
reply ─► 引擎（同一会话，resume）：resolved · withdrawn · open + 反驳 · 新问题
          │
          ▼
   scripts/policy.mjs → continue · done · escalate（僵局 → 你来裁决）
```

- 每个问题的 ID 在整个会话中保持不变。引擎能看到 Claude 的回复和轮次之间的 diff。
- 如果你裁定保留当前版本（`owner-decided`），该问题就会关闭，即使引擎不同意。
- 用完轮次时，无论策略如何判断，都会升级交给你处理。
- Claude 不会提交任何改动。

## 停止策略（`scripts/policy.mjs`）

规则按从上到下的顺序检查，采用第一个匹配项：

1. Claude 将严重程度为 critical/high 的问题留给你（`needs-user`）→ 立即 **escalate**。
2. 引擎给出 `approve`，且没有未关闭的 critical/high 问题 → **done**。Medium/low 问题写入报告，其余待决策的问题交给你。
3. 引擎对同一问题两次拒绝异议 → **escalate**（僵局）。
4. 连续两轮未关闭的问题数量没有减少 → **escalate**（停滞）。
5. 其他情况 → **continue**。

阈值由 `MAX_DISPUTES` 和 `STALL_ROUNDS` 常量定义。修改规则时，也请更新 `tests/run.mjs` 中的 `policy …` 测试。

## build 模式：引擎编写，Claude 审查

```
/agent-duet build                     “交给 Codex……”“让 Codex 实现……”
/agent-duet build --engine agy        “交给 agy……”“让 agy 实现……”
```

1. Claude 编写规格：目标、范围、约束、验收标准和验证方法。
2. 运行器从 HEAD 创建独立的 worktree 和 `agent-duet/<id>` 分支。你的工作区不会被改动，引擎也看不到未提交的内容。
3. 引擎实现功能、运行测试，并报告做了什么、验证了什么、还有哪些不确定。
4. Claude 查看本轮 diff，亲自在 worktree 中运行测试，并提出 C1…Cn 等问题。引擎修复或提出异议。[停止策略](#停止策略scriptspolicymjs)与审查模式相同；僵局交给你裁决（也会显示在 `/duet` 面板中）。
5. 全部达成一致并经你同意后，`finish` 将改动提交到分支并删除 worktree；分支由你自己合并。Conventional Commits 格式的标题（`feat: …`、`fix(scope)!: …`）原样作为提交主题；其他标题会加上 `agent-duet: ` 前缀，已有该前缀时不重复添加。提交正文注明完成实现的引擎以及 Claude 的审查。`discard` 会同时删除 worktree 和分支。

两条命令都会确认注册的 worktree 仍检出 build 分支，且分支指向预期的提交。若本轮中止或失败，待引擎退出后即可选择 `discard` 或 `finish --unreviewed`。对于已经完成或丢弃的 build，`discard` 会拒绝操作。

如果 build 分支已经指向其他提交，`finish`（包括 `--unreviewed`）和 `discard` 都会停止。在 build 的 worktree 中运行提示里的 `git log --oneline <base>..<branch>`，查看该分支上的提交。你可以手动完成该分支的工作。要继续使用运行器，请先用另一条分支保存当前提交，再在 build 的 worktree 中运行 `git reset --soft <base>`，然后重新执行原命令。软重置会保留暂存区和工作区里的内容。

批准之后的改动会作为新一轮审查返回，见[验证与完整性检查](#验证与完整性检查)。给 Claude 的说明在 `references/build.md` 中。

## audit 模式：引擎只检查，不修改

```
/agent-duet audit                     “用 Codex 做审计……”“让 Codex 检查……并给出报告”
/agent-duet audit --engine agy        “用 agy 做审计……”
```

这是一次性报告，不进行协商：审计代码、数据、参考文档或策略，而 Claude 不必花 token 逐条回复发现。如果 Claude 不能自行修改被检查的对象，例如只有经你批准才能修改的参考文档，审查模式就不合适：几乎每个发现都要交给你。build 模式也不合适，因为审计不能修改任何内容。

1. Claude 编写任务：检查什么、回答什么问题、范围、哪些内容算发现，以及哪些内容放入备注（评分、表格）。
2. 引擎在项目目录中以 `read-only` 模式工作。运行器会拒绝其他 `--sandbox` 值。Codex 应用只读 shell 沙箱。agy 会拒绝 `write_file`，但 shell 命令仍可写入。运行器在本轮结束后检查文件，对改动发出警告并保留现场。agy 1.5.10 在此模式下调用 MCP 工具需要 Antigravity 授权。未授权的调用会被拒绝，审计可能因此得不到可用答复。提示词禁止通过已授权的工具写入。参见[安全](#安全)。
3. 只执行一轮。输出包括结论、A1…An 等发现（严重程度、位置、证据、建议、置信度），以及检查过和未检查的内容。Claude 的摘要中每个发现占一行，其余内容保存在会话的 `report.md` 中。
4. 无需回复：audit 模式不接受 `reply` 和 `review`。如需换个角度，请用更明确的任务新建审计。发现仍只是引擎的判断：采用某个发现前，Claude 会先核实，或告诉你它尚未核实。

排队、`/duet` 面板（显示结论和发现）、每轮 12 小时时限以及 `retry`，都与其他模式相同。

## 长时间运行、重试与并行任务

**时间。** 引擎每轮耗时较长，build 尤其如此，因此 Claude 在后台运行 `start`、`reply`、`review` 和 `retry`，并设置 `timeout: 43200000`（12 小时）。Claude Code 后台命令的上限为 `max(2 小时, BASH_MAX_TIMEOUT_MS)`，超过上限的超时值会被静默截断；如何提高到 12 小时，见[安装](#将后台命令时限设为-12-小时推荐)。未明确设置 `timeout` 时，前台命令可运行 2 分钟，后台命令可运行 30 分钟。除非传入 `--timeout-min N`，运行器自身不限制每轮时间。0.6.0 之前创建的会话保留旧的 60 分钟限制；用 `retry --timeout-min 0`（或 `reply` / `review`）即可取消。

**中断的一轮。** 如果引擎尚未确认收到本轮提示，`retry` 会重新发送完整提示及反馈，并尽量沿用原对话。确认送达后，运行器会用简短提示继续本轮。agy 的 `init` 事件提供对话 ID。运行器收到 `user_input` 或后续步骤时才确认提示已送达。恢复代码审查时，批准仍针对最初提交的快照。Codex 可以读取 `~/.codex/sessions` 下的 `.jsonl` 或 `.jsonl.zst` 线程日志。agy 使用 `--conversation` 恢复有 `.db` 文件的对话。如果对话丢失，或你选择 `retry --fresh`，运行器会新建对话。从第二轮起，它会恢复原始任务、问题记录和本轮反馈。已经写入磁盘的文件会保留。

**同时处理多个任务。** 可以同时委派多个任务：每个 build 都有独立的 worktree 和分支。同一台机器最多同时运行十轮引擎任务（`AGENT_DUET_MAX_PARALLEL`），其余任务按顺序在队列中等待（阶段为 `queued`），有空位时自动启动。每个正在运行的一轮都会启动其引擎配置中的所有 MCP 服务器，因此没有队列时，十个任务就可能产生数百个进程。只有引擎工作时才占用名额，Claude 审查期间不占用。排队时间计入后台命令的时限（默认 2 小时，按推荐设置为 12 小时），所以最好一次只安排几个任务，而不是几十个。

## 验证与完整性检查

运行器会核对双方的说法，使结果不只建立在它们的一面之词上。

**你的要求。** 在 `plan`、`code` 和 `file` 审查中，Claude 会传入 Markdown 简报（`start --brief <file|->`），包含三个章节：`## Owner's request`（你的原话，必填）、`## Accepted amendments`（只列你已接受的修改，并注明来源）和 `## Claimed result`（作品作者声称达到的结果）。build 规格本身必须包含要求，可以列出已接受的修改，但不使用单独的 `--brief`。audit 不接受简报。引擎，以及批准 build 之前的 Claude，各自报告 `request_check`：工作是否符合你的要求。引擎在审查中报告的需求缩减，或 build 中双方的分歧，都会交给你裁决。摘要、`status` 和报告都会显示两项检查。

**批准与已审查的目录树绑定。** `finish` 在提交前检查工作区，并在钩子运行后再次检查提交和工作区。只要内容有变，运行器就会撤销本次提交，把改动交回审查，包括钩子留下的新文件。经你明确要求，`finish --unreviewed` 会在提交和报告中记录这一决定，即使改动为空。代码审查后，请在手动提交前运行 `verify`。可以在暂存前检查，也可以只暂存一部分已审查的文件。工作区和每项已暂存的改动都必须与批准的快照一致。尚未暂存的改动标为 `not staged`。如果看到 `unapproved staged content`，请在提交前修正该路径的暂存内容。如果工作文件发生了变化，请使用输出中的 `reply` 命令再次审查。路径标记为 `covered`、`edited-after-review` 或 `never-reviewed`。build 完成后，`verify` 会检查对应分支，若分支已删除则会说明原因。

**问题中的引文。** 每个问题都会引用它所针对的代码行。记录一轮之前，未关闭问题中新增或修改的引文会与已审查的快照核对，并标记为 `ok`、`moved:<L>`（在第 L 行找到）、`other_file:<F>`（在文件 F 中找到）、`MISSING` 或 `unchecked`。关闭问题的回复和未改动的引文保留之前的标记。摘要和提示词会显示引文问题，报告保留这些标记，`/duet` 只在未关闭的问题上标出未找到或位于其他文件的引文。标记不会关闭问题，也不会改变停止决定；`MISSING` 表示需要重新引用，而不是否定该问题。

如果引用的路径格式有效，但在快照中不存在，运行器会搜索整个已保存的快照。找到引文时标记为 `other_file:<F>`，搜完整个快照仍无匹配时标记为 `MISSING`。多行引文支持 LF 和 CRLF 换行符，并保留原始行号。

**验证记录。** 在审查和 build 中，DONE 旁会显示验证标签。标签背后是一份*验证记录*：运行器把引擎声称运行过的命令与其本轮保存的命令事件对照，并在摘要、`report.md` 和 `/duet` 中显示结果、跳过项及原因、未确认或与事件矛盾的说法以及覆盖缺口。标签包括 `executed`（所有检查均已确认，无跳过或缺口）、`partial`（部分已确认，覆盖不完整）、`static-analysis-only`（没有已确认的检查）和 `unknown`（没有验证记录的旧回复）。已确认的失败也可以是 `executed`。标签不会改变停止决定，也不包含 Claude 审查 build 时自己运行的检查。

每个事件只能确认一项检查。运行器去掉 `/bin/zsh -c` 等可识别的 shell 包装后，匹配整条命令，或匹配退出状态可由事件确定的一条完整子命令。参数、引号和重定向必须一致，分隔 shell 词的空格和制表符可以不同。`cd pkg && npm test` 这样的复合命令需要一个记录了整条命令的事件。管道、`eval` 和掩盖退出状态的命令均保留为未确认。验证记录和报告会显示匹配到的命令及其退出码。

## `/duet` 面板与保护措施

模块每 2 秒读取一次会话文件，显示由**当前** Claude 会话负责的审查：运行器会记录调用它的会话（`CLAUDE_CODE_SESSION_ID`），并在每一轮更新。从另一个会话继续审查时，第一次 `reply` 或 `retry` 就会把审查转到那里。其他会话负责的审查只在 `/duet` 面板中显示，带有标记且没有决策按钮；它们不会产生状态条、页脚、通知或声音。0.6.0 之前开始的审查没有归属标记，仍像以前一样在所有会话中显示。

| 位置 | 内容 |
|---|---|
| **面板**（`/duet`） | 会话的全部信息，见下方列表 |
| **输入框上方状态条**与状态行 | 阶段、计时器和引擎当前动作；其他模块的状态条保留在其下方 |
| **页脚** | 类似“Duet r3 ⏳ 4:12”的标签，点击可打开面板。即使关闭状态条也会显示 |
| **通知** | 一轮开始和结束、升级处理、失败；每轮结束后提供“继续 agent-duet”提示（Tab） |
| **声音** | 升级处理（需要你裁决）、审查完成、某轮失败或引擎进程消失时播放；Claude 自己的回合不播放声音。使用 Claude 应用内置的 `tool_approval_needed`、`enter_voice_mode` 和 `disconnected` 提示音，由应用直接播放，不复制到插件中。没有应用时播放 `sounds/` 中的备用声音 |

从 codex-duet 迁移时，每个已打开的 Claude 会话都会导入一次本会话选中的任务、待发送的决定和已展开的问题。已保存的设置由各会话共享。

面板从上到下：

- **任务列表**（有多个任务时）：⏳ 运行中、⏸ 排队中及其位置、🙋 等待你、✅ 已完成，以及计时器和模型。点击一行查看详情。
- **状态**：阶段和本轮计时器；模型与推理级别，仅在 Codex 本轮使用 Fast 时显示 ⚡ Fast；“当前：…”显示引擎正在执行的命令，或在其事件流沉默超过两分钟时显示“已思考 N 分钟”，并在可知时显示对话日志多久前更新过（即使 Codex 默默思考，其线程日志也可能在增长）。
- **验证结果**会显示已确认失败的命令及退出码，即使所有检查都运行过且验证标记为 `executed`。同一命令重跑并确认通过后，这条警告就会消失。
- **引擎的话**：完整的最新消息，按 Markdown 渲染（段落、列表、`代码`），超过两分钟时显示消息时间；它的动作（“运行测试……”“运行 Python 脚本”）；它的计划。
- **升级处理时**会显示原因。对于有争议的问题，可以选择支持哪一方并将决定发给 Claude。如果没有未关闭的问题，但双方对原始请求的理解存在分歧，面板会显示双方记录的评估。
- **问题看板**：● 未关闭、⏸ 待决定、✓ 已修复、↩ 已撤回、⚔×N 次争议，以及显示已关闭问题占比的 ▰▱ 进度条（N/M）。标题会换行而不是被截断；▸ 展开双方的陈述；只要还有未关闭的问题，已关闭的问题就保持折叠。
- **计分板**分别统计构建问题中所有者的裁决和审查方的让步。下方还有轮次历史和设置。

面板文字会按宽度换行；只有任务列表行和引擎命令会被截断。

### 循环不会自行停下

提醒和上下文摘要会涵盖当前 Claude 会话负责的所有活跃任务，即使之后又创建了数百个会话。如果会话正在等待 Claude（回复问题，或审查 build 的一轮），而 Claude 结束了自己的回合，模块会通过 `Stop` 钩子把 Claude 带回循环一次。以下情况不会这样做：

- Claude 向你提了问题，包括以全角问号 `？` 结尾或问号后面还有 Markdown 标记、引号或括号的情况；
- 你发送了消息，Claude 只回复了它，没有推进循环；
- 有后台任务正在运行，或会话已安排唤醒；
- 会话正在等待你的裁决（升级处理）；
- Claude 刚刚已经被带回过循环。

### 提交保护

这项检查帮助 Claude 避免意外执行 Git 写入。保护范围包括所有处于活跃阶段且记录在过去 12 小时内更新过的代码审查和构建。来自任何 Claude 会话的 `git commit`、`push` 和 `stash`，只要目标是受审查的仓库或构建工作树，都会被阻止。符号链接会解析为同一目录，包括迁移后仍使用的 `codex-duet` 旧路径。

- **能识别：** 引号内的路径、`cd`/`pushd`、Git 全局选项、环境变量赋值、命令包装器、复合命令、命令替换、`eval`、shell 的 `-c`，以及传给 shell 的 heredoc 或 here-string。模块会跟踪 `&&`、`||`、`if` 和 `case` 的各个分支，也能识别 `pushd +1` 等目录栈操作、导出的 Git 路径、`env -S`、`git --attr-source` 以及 `+o`、`-c --` 等 shell 选项。同时指定 Git 目录和工作树时，只要其中任一位于受保护的目录树中，写入就会被阻止。
- **出于谨慎而阻止：** 只要存在受保护的会话，目录取决于变量、命令替换或通配符的 Git 写入都会被阻止。如果解析失败（例如嵌套过深），在存在受保护会话时，任何包含 `git` 一词的命令都会被阻止；其他命令放行。
- **放行：** 引号内的普通提及、注释、作为数据的 heredoc、`stash list` 和 `stash show`。
- **无法识别：** Git 别名（`git ci`、`git -c alias.x=commit x`）、会执行提交的脚本和 Makefile（`sh release.sh`、`npm run release`），以及其他在运行时拼装的命令。

### 压缩上下文后

你在被审查项目中发送的消息会附带会话摘要，因此压缩上下文后 Claude 不会丢失循环。后台任务通知不附带摘要，因为运行器的输出已经包含全部内容。摘要和循环提醒只在负责该审查的 Claude 会话中生效。

### 面板命令

`/duet` 打开面板。“停止”按钮和 `/duet stop` 会停止选中任务正在运行或排队的轮次。发送 TERM 前，模块会核对 Claude 会话和所选的运行记录，并通过 `ps` 检查会话锁中 PID 对应的运行器命令和进程启动时间。系统仍有可能在检查之后、信号发出之前将该 PID 分配给其他进程。如果无法核实进程身份，会说明拒绝停止的原因。之后可用 `retry` 继续。使用 `/duet band|toasts|score|sound on|off` 或设置中的按钮切换界面功能。使用 `/duet sound test` 或“▶ 试听声音”依次播放三种提示音。模块会留下一行 `.ui-trace.json` 供调试。会话文件由运行器更新。

运行器退出后，可在 `/duet` 中点击 **“移除”** 来关闭失败的会话。当前 Claude 会话负责的任务和无所有者的任务会显示此按钮。点击后会运行 `discard --session <id>`，并在通知中显示结果。

`discard` 适用于所有会话类型。关闭审计或计划、代码、文件审查时，会保留会话目录、提示和回复。已关闭的会话仍可在最近任务中查看，也不再算作活跃会话。对于 build，该命令会删除 worktree 和分支。

## 引擎差异

| 能力 | Codex | agy |
|---|---|---|
| 模型与推理级别 | 默认值来自 `~/.codex/config.toml`；按 `~/.codex/models_cache.json` 校验 | 系列和级别来自 `agy models`，通常为 `--model gemini-4-carbon --effort high`；级别名为 `low`、`medium`、`high`、`xhigh`、`max`；默认值来自 agy 的 `settings.json` |
| `inherit` | 使用你的 Codex 权限 | 不添加权限参数，使用你的 agy 权限 |
| `workspace-write` | Codex 工作区沙箱 | `--sandbox` 加 proceed-in-sandbox 设置 |
| `danger-full-access` | Codex 完整访问权限 | `--dangerously-skip-permissions` |
| `read-only`，包括所有审计 | Codex 只读 shell 沙箱 | 承诺加上本轮结束后的文件检查；shell 仍可能写入 |
| 恢复 | `~/.codex/sessions` 中已有的线程日志 | agy 目录中仍有对话 `.db` 时使用 `--conversation <id>` |
| 日志 | `round-N.events.jsonl` | 原始 `round-N.agy.jsonl`，规范化的 `round-N.events.jsonl` |
| Fast | 见 [Fast（仅 Codex）](#fast仅-codex) | 无 |

### 选择 agy 模型

通常指定系列和级别：`--model gemini-4-carbon --effort high`。agy 把每个“模型加级别”的组合称为 *slug*，例如 `gemini-3.8-flash-low`；`agy models` 会列出全部 slug。slug、显示名称和系列名称都不区分大小写。

- **系列**（`gemini-4-carbon`）只接受 `agy models` 为它列出的级别。只指定系列、不加 `--effort` 时，由 agy 选择级别。
- **slug**（`gemini-3.8-flash-low`）已固定级别。可以同时传入相同的 `--effort low`；不同的级别会被拒绝，并提示改用系列名称。在 `reply`、`review` 或 `retry` 中只更改 `--effort`，会替换已保存 slug 的级别。
- **只指定 `--effort`** 时，它作用于 agy `settings.json` 中模型所属的系列。
- **没有级别的模型**会原样收到 `--effort`，并附上说明：agy 如何处理它尚未测试。

运行器在启动时或显式更改模型、推理级别时查询 `agy models`，超时为 15 秒。只传 `--model` 会清除之前的级别。后续轮次、批准操作和查看命令都会复用会话保存的模型信息。只指定系列时，运行器从本轮规划器的会话记录读取 agy 实际使用的 slug。若记录不可用，则显示系列名称。摘要、轮次记录和面板会分别标明配置中的系列和显式选择的级别。

若网络故障导致无法查询目录，运行器会跳过目录校验并说明原因。只指定级别时，运行器会读取 `settings.json`，也支持带 UTF-8 BOM 的文件。提示会区分模型缺失、模型未知和设置无法读取。五个级别名称仍会校验。

`AGENT_DUET_AGY_HOME` 指定插件读取 agy 设置和对话日志的目录（默认 `~/.gemini/antigravity-cli`）。它不会重定向 agy 本身：请设为 agy 实际使用的目录。登录仍使用你真实的 `HOME`。

### 选择 Codex 模型

`--model` 和 `--effort` 默认取自 `~/.codex/config.toml`；也可以用自然语言指定，例如“交给 Codex，用 astra 模型，max 推理级别”。运行器会根据你的模型缓存（`~/.codex/models_cache.json`）检查选择，以下情况会在启动前报错并列出可用选项：

- 模型不存在（可以填写 ID，例如 `gpt-6-astra`，或名称，例如 `GPT-6-Astra`）；
- 推理级别不存在；
- 模型不支持该级别，包括 `config.toml` 中的默认级别。

没有缓存时跳过检查。轮次摘要中的 `Model:` 行显示会话实际使用的配置。

### Fast（仅 Codex）

没有单独的开关：Codex 从 `config.toml` 读取速度模式（`service_tier = "priority"`，模型目录中称为 Fast）。只有确定本轮使用 Fast 时，状态条、任务列表和面板（“模型：… · ⚡ Fast”）中才会出现 ⚡ 标记。“（来自配置）”表示配置中启用了 Fast，且目录表明该模型支持它；等 Codex 把本轮模式写入线程日志（`~/.codex/sessions/…/rollout-…-<线程>.jsonl` 中的 `thread_settings_applied` 记录）后，这个附注就会消失。如果日志显示为普通模式，⚡ 标记也会移除。Codex 0.160 会在每次恢复的一轮开始时写入该记录，但新线程的第一轮可能没有。agy 没有 Fast 模式。

## 语言

插件的 `language` 设置可选 `auto`（默认）、`en`（英语）、`ru`（俄语）或 `zh`（简体中文）。它控制插件界面以及插件发给 Claude 的备注和消息；运行器的输出始终是英语。更改设置后，模块会重新加载。

要从 shell 将语言设为俄语，请运行：

```bash
echo '{"language":"ru"}' | claude plugin configure agent-duet --values-stdin
```

可以把 `ru` 换成 `en`、`zh` 或 `auto`。`--values-stdin` 读取一个值为单行字符串的 JSON 对象；未提供的选项保留当前值。不加 `--values-stdin` 时，`claude plugin configure agent-duet` 只显示配置。也可以在 `/plugin` 菜单中插件所在的行更改语言。

**`auto` 如何选择语言。** 依次读取 `LC_ALL`、`LC_MESSAGES` 和 `LANG`，使用第一个非空值：以 `ru` 开头选择俄语，以 `zh` 开头选择简体中文，其他值选择英语。只有当这三个变量都未设置或为空时，macOS 才会读取 `AppleLanguages` 中的第一个首选语言，并按相同规则选择。其他平台、首选语言列表为空或读取失败时，使用英语。

## 安全

- 每个引擎都使用它平常的配置：你的设置、模型、推理级别、已配置的 MCP 服务器以及它能使用的其他工具。
- `--sandbox inherit` 使用引擎自己的权限。对于 Codex，明确指定的模式会应用于每一轮：启动时用 `-s`，`resume` 时用 `-c sandbox_mode=…`，因为 `resume` 没有 `--sandbox` 参数。agy 的映射见[引擎差异](#引擎差异)。
- **agy 的 read-only 是承诺加上本轮结束后的检查，不是强制沙箱。** 它拒绝 `write_file`，但 shell 命令仍可写入。每个只读轮次前后，运行器会对 Git 仓库工作目录下已跟踪和未跟踪的非忽略文件计算指纹；在 Git 之外，只扫描有数量上限的文件。检测到的改动会被记录并警告，但不会撤销。被忽略的文件、工作目录之外的路径、超出上限的文件，以及检查前已还原的改动，都可能漏检。这种检查无法让运行不可信代码变得安全。
- **审查期间不得修改文件、不得提交、不得更改外部系统，这些都是提示词中的指令。** 对于外部 PR 或下载的文件，请选择 `--sandbox read-only`：Codex 会应用其 shell 沙箱；agy 只有上面所说的承诺和检查。
- **MCP 权限与 shell 权限分别控制。** 在 agy 1.5.10 的只读模式下，匹配的 Antigravity 授权允许调用整个 MCP 工具。没有授权时，无界面的 agy 会拒绝调用。如果随后没有可用答复，本轮就会失败。已授权的工具按其配置的权限运行，可能有权写入外部系统。这类写入只由提示词禁止。Codex 的沙箱适用于 shell 命令。它的 MCP 工具按配置的权限运行，提示词也禁止通过这些工具写入。
- **macOS 钥匙串与临时 `HOME`。** 启动 agy、claude、gh、Git 凭证助手或 `security` 时使用真实的 `HOME`。从 1.5.9 起，agy 将 OAuth 令牌存储在 macOS 钥匙串中。如果读不到令牌，agy 可能会在浏览器中打开 Google 登录页。测试时将 `AGENT_DUET_AGY_BIN` 指向模拟程序，并为 `AGENT_DUET_AGY_HOME` 设置临时目录。claude 和 gh 可分别通过 `CLAUDE_CODE_OAUTH_TOKEN` 和 `GH_TOKEN` 获取凭证。如果 macOS 提示找不到钥匙串，请点击**取消**。「重设为默认设置」会创建新的钥匙串。将 `~/Library/Keychains` 链接到测试目录会让进程访问整个钥匙串。

## 文件布局

| 路径 | 内容 |
|---|---|
| `.claude-plugin/` | `plugin.json` 是插件清单；`marketplace.json` 是只包含本插件的市场，用于安装 |
| `SKILL.md`、`references/protocol.md`、`references/build.md` | 给 Claude 的指令 |
| `README.md`、`README.ru.md`、`README.zh-CN.md` | 英语、俄语和简体中文文档 |
| `scripts/duet.mjs` | 运行器：调用引擎、问题记录、快照和输出 |
| `scripts/policy.mjs` | **你的**停止策略 `decideNextStep` |
| `prompts/`、`schemas/` | 引擎的提示词和回复的 JSON schema |
| `hooks/register.tsx`、`types/index.d.ts` | 模块：面板、状态条、页脚、通知、声音、循环提醒、提交保护和上下文摘要 |
| `hooks/locales/en.ts`、`hooks/locales/ru.ts`、`hooks/locales/zh.ts` | 界面和会话消息的翻译；英语表定义键的集合 |
| `sounds/` | 没有 Claude 应用时使用的备用声音；运行 `node sounds/make.mjs` 可重新合成 |
| `tests/` | `run.mjs`：运行器和策略；`mod.mjs`：在模拟的 Claude Code 插件运行环境中测试模块；`pane.test.tsx`：通过 Claude Code 自带的插件测试工具渲染面板 |
| `~/.local/state/agent-duet/<id>/` | 会话：`state.json`、各轮提示词和回复、`report.md` |

要重新打开引擎的对话，Codex 使用 `codex resume <thread id>`，agy 使用 `agy --conversation <conversation id>`；ID 见报告。每轮规范化后的事件保存在 `round-N.events.jsonl`（用于验证和面板），agy 的原始输出保存在 `round-N.agy.jsonl`。两个引擎解析后的回复都沿用兼容名称 `round-N.codex.json`；会话 ID 和内部状态字段保持不变。

## 环境变量

请使用下表中的 `AGENT_DUET_*` 名称。旧的 `CODEX_DUET_*` 名称仍然有效；两者都设置时以新名称为准，即使新值为空。Codex 自己的 `CODEX_HOME` 和 `~/.codex` 保持不变。

| 变量 | 用途 |
|---|---|
| `AGENT_DUET_ENGINE` | 启动时的默认引擎：`codex` 或 `agy`（默认 `codex`） |
| `AGENT_DUET_MODEL`、`AGENT_DUET_EFFORT` | 默认模型和推理级别 |
| `AGENT_DUET_TIMEOUT_MIN` | 引擎每轮时限，单位为分钟（默认 0，即不限制） |
| `AGENT_DUET_TIMEOUT_MS` | 以毫秒覆盖每轮时限（主要用于测试） |
| `AGENT_DUET_KILL_GRACE_MS` | 从 SIGTERM 到 SIGKILL，或从退出到关闭管道的宽限时间（默认 5000 毫秒） |
| `AGENT_DUET_MAX_PARALLEL` | 同一台机器上同时运行的引擎轮次数（默认 10），其余排队 |
| `AGENT_DUET_QUEUE_POLL_MS` | 队列轮询间隔（默认 3000 毫秒） |
| `AGENT_DUET_SANDBOX` | 默认沙箱模式（`inherit`） |
| `AGENT_DUET_HOME` | 会话存储目录，按原值使用；默认为 `$XDG_STATE_HOME/agent-duet` 或 `~/.local/state/agent-duet` |
| `AGENT_DUET_POLICY` | 替代的策略文件（测试使用） |
| `AGENT_DUET_CODEX_BIN` | Codex 可执行文件（默认 `codex`） |
| `AGENT_DUET_AGY_BIN` | agy 可执行文件（默认 `agy`） |
| `AGENT_DUET_AGY_HOME` | 插件读取 agy 设置和日志的目录（默认 `~/.gemini/antigravity-cli`）；不会重定向 CLI，也不会更改 `HOME` |

## 从 codex-duet 升级

本插件在 0.12.0 及更早版本中名为 codex-duet。所有内容都会自动沿用，无需手动操作：

- **会话。** 运行器首次调用时，会把旧的默认状态目录（`…/codex-duet`，通常是 `~/.local/state/codex-duet`）移到新的默认位置（`…/agent-duet`），并在旧位置留下符号链接，让旧的绝对路径继续有效，例如正在运行的进程和旧 build 的 worktree 所用的路径。如果两个目录都存在，只使用新目录。通过 `AGENT_DUET_HOME` 或 `CODEX_DUET_HOME` 显式指定的目录永远不会被移动。模块只读取这些路径，它的调试跟踪文件（`.ui-trace.json`）与会话放在一起。如果迁移中断，下次调用会修复缺失的兼容符号链接。
- **环境变量。** `CODEX_DUET_*` 名称仍然有效，见[环境变量](#环境变量)。
- **分支。** 名为 `codex-duet/<id>` 的 build 分支仍能识别；新分支名为 `agent-duet/<id>`。
- **面板状态。** Claude Code 会在热重载之间保留模块的状态。你的偏好、选中的任务、在面板上选好的决定以及展开的问题，会从 codex-duet 导入一次；agent-duet 自己的偏好优先。
- **语言。** 在你为 agent-duet 配置语言（包括显式选择 `auto`）之前，沿用为 codex-duet 保存的语言。

## 故障排查

### agy（已用 1.5.10 测试）

- **启动时没有输出。** agy 会等所有已配置的 MCP 服务器连接后才开始工作。请检查 VPN 和网络，并用相同的 agy 配置运行 `agy mcp list`：一个无法连接的服务器就可能拖住这一轮。排队和后台超时仍然有效。
- **登录或凭证管理器出错。** 运行器会在 agy 启动期间阻止自动打开浏览器登录，并在凭证访问失败时停止。请解锁钥匙串，在使用真实 `HOME` 的终端中登录 agy 后重试。
- **工具被拒绝。** 如果本轮成功，运行器会保留答复并列出被拒绝的操作。如果 MCP 调用被拒绝并导致只读轮次失败，请在 Antigravity 应用中为指定工具选择 **Always Allow**，或将对应的 `mcp(<server>/<tool>)` 条目加入 `~/.gemini/config/config.json` 的 `userSettings.globalPermissionGrants.allow`。也可以在任务中明确禁止 MCP 后启动新审计，或使用 `--engine codex` 启动新审计。其他工具被拒绝时，请检查 agy 设置中允许使用的工具。
- **长命令未获确认。** 运行器会从完整会话记录中恢复被截断的命令。无法恢复时，核验记录会注明原因。命令被取消或输出缺少 agy 的退出状态标头时，退出结果也无法确认。
- **Retry 重新开始。** 检查保存的对话 `.db` 是否仍在 `AGENT_DUET_AGY_HOME`（默认 `~/.gemini/antigravity-cli`）中。只有文件存在时，`retry` 才会使用 `--conversation`；`--fresh` 则是有意重新开始。
- **违反只读约定。** 请先检查记录中列出的文件。即使会话存放在项目内，比较时也会排除当前运行器的事件日志、状态和答复文件。运行器会记录项目文件的变更，保留现场供你检查。参见[安全](#安全)。

### Codex CLI 的注意事项（0.159）

- 当 stdin 不是终端时，`codex exec` 会等待 stdin 的 EOF，表现为无声挂起。运行器会通过 stdin 传入提示词，然后关闭它。
- `codex exec resume` 不接受 `--sandbox`、`--cd` 或 `--color`。
- `-c 'mcp_servers={}'` 不能关闭 MCP：配置值会合并，而不是替换。
- `codex mcp list --json` 会**不加掩码**地输出服务器的环境变量，包括 token。

## 开发

Claude Code 会自动加载 `~/.claude/skills/agent-duet` 中的克隆，无需安装。Claude Code 用 `<名称>@<来源>` 表示插件：从本仓库的市场安装时为 `agent-duet@agent-duet`，作为 `~/.claude/skills` 中的克隆时为 `agent-duet@skills-dir`。修改会在新会话中生效。此时不要再从市场安装同一个插件：已安装的插件会覆盖同名的 skills-dir 插件，克隆随后会显示为“Not loaded”。

## 测试

```bash
node tests/run.mjs
node tests/mod.mjs
claude plugin test .
claude plugin validate .
```

在插件目录中运行。GitHub Actions（`.github/workflows/tests.yml`）也会在 macOS 和 Linux 上运行 `run.mjs` 和 `mod.mjs`。

`run.mjs` 使用模拟 Codex（`tests/fake-codex.mjs`）测试运行器：问题记录、争议、升级处理、`retry`、`resume` 时的 read-only、轮次之间的 diff，以及策略的英语原因消息。它还会运行验证测试、兼容性测试，以及基于模拟 agy 的 agy 测试（`tests/agy.mjs`）；agy 测试也可以用 `node tests/agy.mjs` 单独运行，既不需要真实的 agy，也不需要网络。

`mod.mjs` 转译真实的 `hooks/register.tsx` 及其本地静态导入，然后在模拟的 Claude Code 插件运行环境（`tests/mod-engine.mjs`）中运行其钩子。会话由 `duet.mjs` 使用同一个模拟 Codex 创建。测试覆盖面板、状态条、页脚、通知、声音、循环提醒、提交保护和上下文摘要，包括默认英语、显式选择的俄语和中文、`auto` 中的 locale 优先级、macOS 首选语言回退和读取失败时使用英语、会话消息和决定的翻译，以及三张语言表的键是否一致。转译需要 esbuild（全局 `tsx` 内附的版本也可以）或 `typescript`；可通过 `ESBUILD` 或 `TYPESCRIPT` 指定路径。模拟环境能发现逻辑错误，但发现不了对插件 API 的误解：新增 API 调用时，请对照 `claude-code.d.ts` 并运行 `claude plugin validate`。这一思路来自 plan-progress（[zycck/claude-mods](https://github.com/zycck/claude-mods)）。

`tests/pane.test.tsx` 通过 Claude Code 自带的插件测试工具（`claude plugin test`），在 terminal、desktop 和 mobile 三种界面上以英语、俄语和简体中文渲染面板。每种界面的组件表都会校验渲染树，这是模拟环境做不到的。审查会话保存在测试内存中。测试检查长标题和“其他会话的审查”标记是否完整可见、问题能否展开，以及引擎的消息是否按 Markdown 渲染；44 列的窄布局还会检查双倍宽度的中文字符能否正确换行。

## 禁用或卸载

```bash
claude plugin disable agent-duet@agent-duet
claude plugin uninstall agent-duet@agent-duet
```

`~/.claude/skills` 中的克隆也可以用相同方式禁用，名称改为 `agent-duet@skills-dir`；删除其目录即可卸载。

## 许可证

MIT，见 [LICENSE](LICENSE)。
