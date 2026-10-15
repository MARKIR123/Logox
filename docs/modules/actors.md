# 角色定义、管理与技能分配

角色目录提供 Logox、Aletheia、Techne、Kalon 的中文人设、职责、现有颜色符号、压缩契约和参数。运行时、应用和界面通过目录取定义，目录不执行任务，不改变主模型。入口为 [catalog](../../src/actors/catalog.ts)、[definitions](../../src/actors/definitions.ts)、[builtins](../../src/actors/builtins.ts) 与 [management](../../src/actors/management.ts)。

## 定义文件与覆盖

内置人设与摘要契约放在 [profiles](../../src/actors/profiles/) 的 `<id>/persona.md` 与 `<id>/compression.md`，各角色自成一篇，原样载入；结构化字段仍在 builtins。`npm run build` 把 profiles 复制到 dist。写作规则见[人设设计](../development/designs/2026-10-12-persistent-actors.md#人设写作与舞台呈现)。未经目录装配的 `agentRequestBase` 调用回落到同一份内置人设。

加载顺序是内置 → `~/.logox/actors/*.md` → 当前项目 `.logox/actors/*.md`，同 ID 后者覆盖前者。用户目录 `~/.logox-ts/actors/<id>/` 的三文件档案（config.yaml、persona.md、compression.md）尚未接入当前加载器。文件名须与 ID 一致。每份文件是完整角色定义：YAML Frontmatter 写 `id/name/title/description/color/symbol/compression/context`，正文写 prompt；可选 `card_closed`、`card_open`、`defaultModel: {provider, model}` 和 `skills` 名称列表。未指定卡片底色时由高亮色自动推导暗底。不自动写用户目录。

```markdown
---
id: scout
name: 侦察者
title: 资料调查
description: 查证资料并给出证据位置。
color: "#7ee7c4"
symbol: "◇"
card_closed: "#2c473d"
card_open: "#395c4f"
compression: 保留核心发现、证据位置、验证状态与未查清问题。标题一句话，报告简短，同一次产物复用。
context:
  keep_recent_rounds: 0
  keep_recent_tools: 2
skills: [research]
---
你是资料侦察者，先核对来源，再给出有依据的结论。
```

`context` 接受 [ContextPolicy](../../src/config/config.ts) 的结构化字段，未知字段拒绝。省略的保留字段按角色补齐：Logox 为 2/2，Kalon 为 0/0，其余 Actor 为 0/2；预算字段沿用项目配置。内置 Logox 使用项目 context，显式角色定义可覆盖它；/actors 显示合并后的实际参数。数值不藏在人设文字里，触发由运行时负责。

ID 仅允许小写字母开头的字母、数字、下划线和连字符，最长 64 字符；拒绝 legacy 和 Windows 设备名。名称、职责、人设、契约不得为空或含控制字符；颜色是六位十六进制，符号不含空白。重复 YAML 键、别名、未知字段、非普通文件、符号链接路径、错误 UTF-8、超过 64 KiB 或超过 256 项目录均报告诊断。一次重载任一文件失败时保留上一份完整有效定义快照，修复后重载才发布新版本；删除有效覆盖文件后正常回落。

## 装配接口

- `new ActorCatalog(cwd, {home?})`；`load/reload(): Promise<ActorSnapshot>`；`snapshot/list/find(id)` 读取不可变定义。快照包含 `definitions/issues/revision`；失败不增加有效版本号。任务开始应捕获定义，重载影响后续任务。
- `ActorDefinition` 提供 `id/name/title/description/color/symbol/prompt/compression/context/defaultModel?/skills`。模型模块消费可选 `{provider, model}`；摘要模块消费 `context` 与 `compression`，不复制加载规则。
- `new ActorManagement(catalog, registry)` 只要求注入 `ProviderRegistry.modelCatalog`。`tab()` 返回可放入现有页签列表的 `CommandTab`；`openDefaultModel(id, surfaces)` 复用现有 picker。候选区分提供商和模型 ID，包含继承选项，确认时再次核对目录。取消不保存，确认只改变此角色项目定义，保留现有项目人设。
- 正式应用另注入空闲校验和生效策略回调：模型保存前复核任务状态，管理页展示角色覆盖与项目配置合并后的参数。
- `saveDefaultModel(id, model | undefined, signal)` 原子保存项目覆盖后热载；`undefined` 删除角色默认模型、恢复继承。不选择主 Registry，不复制认证或模型目录。
- `craftActor(content, approve, signal)` 先校验并向审批回调提交冻结的 `{operation: 'craft_actor', path, content, previous}`。应用必须把该回调接到运行时工具审批，并仅在批准时返回 true。拒绝返回 `{status: 'denied', path, revision}`；批准后原子写项目文件、热载，返回 `saved`。取消、审批期间文件改变或已有内容与审批原文不一致时不覆盖。内部写入串行；新增使用独占硬链接发布，覆盖使用临时文件 rename。热载失败明确说明文件已保存，目录仍保留有效快照。

正式应用已接入 `/actors` 页签、`/actors model 角色` picker、`/reload`、动态窗口与 craft_actor。Logox 的工作模型使用 `/model`。模型确认保存前复核空闲状态；角色人设和参数直接编辑定义文件再重载。

[ActorServices](../../src/actors/services.ts) 捕获任务定义、维护本次借阅及 Director 派工批次。dispatch_role 同批同角色合并，子任务结束后只回传标题和报告；主回合不等待排在自己后面的任务。request_assist 交给 Director 的后续任务审批，批准后 send_message 可交替发送最多六条消息；取消、重启或回退关闭无效渠道。

## 停止、暂停与异常接管

[Ensemble](../../src/actors/ensemble.ts) 持有一条串行队列，任务带父活动、根目标和批次身份。`dispatch(owner, prompt, source, origin?)` 返回句柄，登记后即返回；内部优先队列不能等待自己排出的任务。`pauseBatch/resumeBatch` 只暂停和恢复该批次尚未执行的任务，保留原 activityId；独立批次继续。暂停任务保存 `paused` 检查点，不被视为取消或完成。

用户停止某张 Actor 卡片时，应用先调用 `ActorServices.stopActor(activityId)` 暂停依赖批次，再调用 `ensemble.cancel(activityId, 'user')`。取消只作用于该活动的 AbortSignal 和工具。主窗口停止 Logox 时先调用 `stopDirector` 关闭自动接续，再取消 Logox；父信号不联动取消子 Actor。晚到报告保留在协调状态。应用在下一次正式输入登记 Logox 活动后调用 `resumeDirector(activityId)`，将返回简报注入该活动的模型上下文，用户消息仍保留原输入。它只开放后续判断，不自动恢复暂停队列；不传 activityId 只预览，不消费报告。

`ActorRecovery.canResume(activityId, rootActivityId)` 只允许该活动已接收报告中的原根目标；它用于任务归属校验，不代替用户授权。新输入明确调用 `resumeTask` 时允许跨新输入 ID 续做被交接的旧任务，子活动仍保留原根目标及故障预算。其它历史目标、用户停止、非失败活动和重复安排继续拒绝。已结束且无剩余活动的同一原批次不再阻止有效续做；未知或未交接批次仍拒绝。一次派发不能混合不同根目标的续做，失败分别报告具体原因。

Actor 技术终止后立即暂停同批后续，将 Journal 本地摘要交给优先 Logox 任务；直接 @Actor 的技术终止也交接。失败收尾不再请求出错模型做摘要压缩，原始账本和本地摘要保留；成功任务仍执行正常整理。普通工具报错但循环尚能继续由当前 Actor 处理。用户停止、关闭与模型配置不可用不进入自动补救；模型选择仍由用户确认。

模型终止的交接另带运行时确认的实际原因；此前单条工具报错与真正使循环终止的模型错误分开判断。HTTP 402 属于余额/额度问题，保存原进展并交用户处理配置，不再派出 Logox 请求同一模型反复补救。

模型无进展超时或传输断连后，交接明确要求 Logox 优先调用 `dispatch_role({tasks: [{ownerId, resumeTask: "失败活动ID", prompt: "继续要求"}]})`。`isProviderInterruption` 根据超时诊断或 connection/stream 阶段识别这类故障；限流、过载和配置错误不按断流处理。运行时校验原任务在当前根目标内、对应同一角色、为失败状态且没有用户停止或重复续做，再补充原目标和保留工具结果的约束。Actor 使用自身有效上下文，创建新活动和新模型请求继续剩余工作，不重放旧调用；不恢复服务端断掉的生成连接。`recovery.actorTask` 在 Logox 接管本身失败时继续传递原角色目标；续做不增加新分工深度，仍共享两次故障补救预算。

[ActorRecovery](../../src/actors/recovery.ts) 用独立 StateFile 保存主循环接续门、待交接报告、已绑定活动的报告和根目标故障预算。补救最多两次，换执行者和 Logox 接手继承同一预算；耗尽后只交给 Logox 说明，`dispatch_role` 拒绝继续派工，应用同时禁止此回合执行工具。报告先持久绑定接收活动，完成时才删除；失败或取消退回待交接。重启把尚未完成消费的绑定报告退回待交接，不启动模型；`recover(validActivities?)` 按报告根目标清除回退后无效的数据，接收方排队检查点尚未保存也不会丢失有效原结果。`flush()` 用于关闭时等待保存。空白恢复不创建协调文件，旧文件缺少 assigned 字段时默认空列表。恢复状态不会自动重放任务或工具。

Logox 可使用 `dispatch_role({resumeBatch: "批次ID"})` 恢复现有依赖任务，省略 `tasks`。只允许当前根目标的批次，或用户新输入明确开放判断的暂停批次；恢复不重新派发已存在任务。跨执行者的 `TaskOrigin.recovery` 传递预算身份，实际故障计数由协调状态维护。

Actor 自动报告带 inputKind=actor 交接；主舞台只更新原卡片的完成标题和展开报告，不发布新的用户行。真人输入、Director 派工与协作分别使用 human/director/collaboration；子任务继承原任务真人 authorization。审批不会将派工或报告当成真人授权；模型请求用来源说明包装角色数据，旧账本按已有 source 解释，原文件不改写。

用户直接 @Actor 时，主舞台显示轻量提示；主请求从有效任务检查点派生至多十六条近期直接对话索引，需要详情由 read_actor 拉取。索引不追加到旧 Logox 轮次，不改变原摘要绑定。角色任务结束采用同一压缩服务，默认零旧轮与工具 2/2/0；详细流程保留原账本。

## 阶段执行与输出恢复

复杂任务由 Actor 在同一次任务内维护阶段，工具继承阶段目的。`update_task_progress` 登记计划、切换当前阶段、报告完成成果或取消原因；已完成记录不可改写，修订与步骤快照落入检查点和原始账本。`resumeTaskId` 续做载入原阶段，不重新分类已发生步骤。简单任务不强制建清单。

`ExecutionRecoveryError` 区分只有思考／空回复、正文截断和工具截断，不当成 provider 故障。Actor 一次自纠偏后仍无交付，Director 用共享根预算调整一次；仍无交付只保留交接，不再自动启动解释请求。正文与工具截断共用两次接续，超限 Actor 交 Director 核对一次部分成果，不刷新同类预算或重复已完成副作用。

ActorRecovery 的 execution 状态保存当前额度、累计次数、成果指纹和历史。普通工具新成功结果或新的阶段成果结束连续无交付；重复结果、计划更新和派工不刷新。用户明确继续可以授予新组，原计数与成果指纹保留；网络预算不增加。重启只恢复记录，阶段和待交接报告不会自行触发推理。收尾明确剩余工作，由 Director 验收，具体规则见[阶段与恢复设计](../development/designs/2026-10-14-task-progress-and-reasoning-recovery.md)。

## 技能可见性

[Resources](../../src/resources/manager.ts) 保持 `ResourceOptions` 与 `snapshot()` 兼容，技能元数据增加可选 `actors`。`SKILL.md` 的 YAML `actors: [kalon]` 与角色 `skills` 双向声明按并集开放；未声明 `actors` 的技能默认供 Logox 使用，空列表不默认开放。

`skillsFor({actorId, skills?, borrowed?})` 返回当前角色技能；`skills` 传入该角色定义列表，`borrowed` 只传入本次任务借阅。`assignSkill(name, actorId, assigned?)` 维护当前 Resources 实例的显式分配，可撤销；不写角色或用户文件。`prompt(visibility?)` 用同一过滤结果生成技能索引，无参数保持 Logox 调用兼容。借阅不会写分配表，下次任务自然失效。加载索引不注册工具或替代基础工具审批。

同名技能仍按用户 → 项目覆盖，原目录、legacy、大小和真实路径规则保持。技能 actors 字段无效时报告并跳过该份技能，不开放给其它角色。应用需要把角色定义的 skills 和任务借阅参数传给提示组装入口。

## 验证入口

[runtime-steps.test.ts](../../tests/runtime-steps.test.ts) 覆盖真实 Agent 请求开始、审批前工具卡、独立耗时、并发返回时冻结、Actor 回传后的真人授权及旧账本不改写；[stage-interaction.test.tsx](../../tests/stage-interaction.test.tsx) 验证卡片灰底命中和拖选不停止。

[actor-definitions.test.ts](../../tests/actor-definitions.test.ts) 覆盖目录与管理；[actors-integration.test.ts](../../tests/actors-integration.test.ts) 验证正式动态角色、确认转用、临时借阅、精确塑造审批、重启和回退；[actor-cards.test.tsx](../../tests/actor-cards.test.tsx) 验证模拟 Ink 的动态窗口、草稿、摘要卡片与新请求展开。真实终端和多厂商角色任务仍需现场验收。

[actor-recovery.test.ts](../../tests/actor-recovery.test.ts) 验证故障优先接管、暂停批次、停止隔离、主循环停止后的晚到报告、直接 Actor 异常、两次补救上限、重启预算、回退清理和原队列恢复；[ensemble.test.ts](../../tests/ensemble.test.ts) 保留串行、排队取消与异步保存取消回归。

派发、角色读取、技能借阅、协作与塑造统一遵守[三档权限](../development/designs/2026-10-12-permissions-and-scheduling.md)。塑造在完整正文与旧版本校验后裁决，default 人工确认，auto 由会话模型审查，creative 危险过滤后允许；角色默认模型不替代审批模型。
