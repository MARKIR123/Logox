# 角色与协作

角色把职责、提示词、模型选择与独立历史放在一起。Logox 负责协调，Aletheia 调查核验，Techne 实现和测试，Kalon 处理设计与表达。使用方式见[使用指南](../USAGE.md)。

## 定义与覆盖

内置档案位于 `src/actors/profiles/<id>/`，包含 `config.yaml`、`persona.md` 和 `compression.md`。用户和项目可以覆盖同 ID 的定义，也能添加自己的角色。

`src/actors/profiles/` 是分发母本，构建只复制到 dist。安装时或执行 `logox --install-profiles` 时，将缺失档案复制到 `~/.logox/actors/`，不覆盖已有文件；运行时从用户目录读取母本，再加载用户旧目录和项目覆盖。开发命令 `npm run sync:profiles` 可单向同步母本。当前支持三文件目录档案，也保留带 YAML frontmatter 的单个 Markdown 定义。目录加载仅迁移内容指纹匹配已知旧默认值的 `compression.md`，自定义内容、人设、配置和模型绑定保持不变。

例如在项目 `.logox/actors/scout.md` 中写入：

```markdown
---
id: scout
name: Scout
title: Research
description: Investigate implementation details and report evidence.
color: "#7ee7c4"
symbol: "◇"
compression: Preserve findings, evidence, verification and open questions.
context:
  keep_recent_rounds: 0
  keep_recent_tools: 2
---
Investigate the requested question and report concrete evidence.
```

修改后在空闲时执行 `/reload`。角色 ID、颜色、字段、编码和大小都要通过校验；路径不允许符号链接。重载遇到无效定义时保留上一份完整有效快照，不发布半套角色。

`/actors` 查看角色；`/model <actor>` 设置默认模型。模型绑定会写入用户 `actor-models.json`，并保存项目角色定义；未配置时继承会话模型。覆盖人设时应保留自己需要的字段，不能假设只写一段正文就会自动合并所有配置。任务开始后使用固定的角色与模型状态，详见[任务模型](task-models.md)。

## 队列、消息与技能

每个角色有独立上下文与队列，同角色任务串行，不同角色可并发。派工先登记活动，执行时再读取该角色历史。角色不是独立文件系统沙箱；同时修改同一文件仍需协调。

Logox 可派工、读取角色结果、塑造角色和取消活动。派工不会阻塞等待自己队列里的后续任务；正式派工以完整任务报告交接，内部轮次记忆另行保存，完整流程留在角色账本。直接 `@actor` 使用自然回复，记录可按需读取，不把全部独立对话重复塞入 Logox 历史。

`SendMessage` uses the current-activity inbox by default, distinct from a human Queue submission for a later task. Actor-directed interrupt may stop an active tool. Director-bound direct messages and broadcasts instead use priority coordination events and do not cancel Director. Necessary communication does not grant human authorization.

### Director facts and delivery

`DeliveryQueue` serializes durable admission and boundary receipts. Human steering is activity-bound; task reports and explicit assistance preserve source/root identities and full report text. Human input precedes background wake tasks, while failure/help events precede normal report events. Equal-priority order is FIFO. Available events are consumed together at model boundaries, including finalizer, context-preparation and retry races; ordinary tool activity does not trigger a new Director call.

Formal batch members report independently rather than waiting for their siblings. A failure still pauses dependent queued work and preserves the existing shared-root recovery budget and dispatch depth. Runtime delivery and task acceptance remain separate. Direct human/Actor failures stay local unless assistance is explicitly requested. Human stop gates automatic wake-ups, including a wake already queued behind a closing Director; new human Director work releases deferred reports only when that activity actually starts. Recovery eligibility is checked against the target root, so delivery to an unrelated busy Director or a later sibling report cannot weaken exhaustion. An explicit human continuation grant applies only to its root and acknowledges existing recovery events; subsequent failures still enforce their own limits.

The resident facts projection includes relevant task ancestry, exact lifecycle state, optional self-reported labels and at most three recent tool outcomes per task. It includes at most eight task records and reports the remaining count. No unrelated idle roster is injected. `ListActors` enumerates dynamic roles and exposes detailed or sanitized observations according to the caller. Raw result bodies are not copied into the snapshot, and command success does not imply task verification.

Delivery IDs and append-only journal receipts support normal deduplication and retry after interrupted recipients. Terminal handoffs stage the full prepared event on the producer checkpoint before queue admission; a transient queue write failure can be retried at settlement or restored on startup without rerunning child work or claiming another recovery attempt. A Director recovery handoff records its successor event rather than repeatedly requeueing the predecessor. Queue state is branch-aware and mirrored as `deliveries.json` in the human-readable session tree. Restart preserves pending coordination without automatically restarting providers or tools; activity-bound inputs are cancelled rather than retargeted. This is at-least-once recovery, not exactly-once side effects. No timer, semantic stagnation judge or read limit is added.

技能可由角色目录、frontmatter、角色的 `skills` 列表或显式分配开放。本次任务借阅只影响本次上下文，不修改持久分配。技能提供流程文字，不会绕过工具权限，格式见[资源与扩展](resources-and-extensions.md)。

## 取消与失败

- 停止 Actor 只取消对应活动及其工具，并暂停依赖批次；独立任务不因此全部停止。
- 停止 Logox 不联动取消 Actor，晚到报告保存，等待下一次正式输入处理。
- Technical failures in formal Director work can return to the coordinator; direct human/Actor failures remain local. Recovery shares the root-task budget across executors and restart.
- 用户停止、认证/额度问题和模型配置错误不会一律触发自动补做。
- 恢复读取状态与进展，不重放已完成工具；部分成功必须与未完成工作一起报告。

任务进度工具 `UpdateTaskProgress` 只可选设置当前活动标签 `label` 和说明 `detail`，不再登记阶段计划或维护完成状态。标签只显示在运行中的角色卡片；完成、失败或取消后自动回到任务或报告标题。普通新轮不继承旧标签，只有显式续做继承；历史阶段和步骤记录保留但不再生成正文标题。标签是角色自述，不是验证证据，也不刷新执行恢复预算。内部轮次记忆与完整任务报告分别保存，摘要整理失败不应把已经完成的工作改判成失败。

## 源码入口

- [catalog.ts](../../src/actors/catalog.ts)、[definitions.ts](../../src/actors/definitions.ts)：定义加载与校验。
- [management.ts](../../src/actors/management.ts)：角色管理与模型绑定。
- [ensemble.ts](../../src/actors/ensemble.ts)：调度、取消与任务终态。
- [services.ts](../../src/actors/services.ts)、[collaboration.ts](../../src/actors/collaboration.ts)：派工、消息与技能借阅。
- [recovery.ts](../../src/actors/recovery.ts)：故障预算、暂停与持久交接。
- [delivery-queue.ts](../../src/actors/delivery-queue.ts), [delivery.ts](../../src/runtime/delivery.ts): durable delivery contracts, priority and consumption receipts.
- [facts.ts](../../src/actors/facts.ts): bounded execution observations shared with Director and ListActors.

测试入口：[角色定义](../../tests/actor-definitions.test.ts)、[协作](../../tests/actor-collaboration.test.ts)、[恢复](../../tests/actor-recovery.test.ts)。
