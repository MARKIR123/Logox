# 角色与协作

Logox 里的工作由几个角色分担：Logox 负责协调，Aletheia 调查核验，Techne 实现和测试，Kalon 处理设计与表达。这个模块管角色的定义、任务队列、角色之间的消息，以及取消和失败的处理。使用方式见[使用指南](../USAGE.md)。

## 核心概念

- **角色档案**：一个角色一个目录 `src/actors/profiles/<id>/`，必备 `config.yaml`（配置）、`persona.md`（身份和语气）、`compression.md`（上下文整理时优先保留什么），可选 `execution.md`、`collaboration.md`（角色私有的行动与协作规则）。公共规则由系统统一拼装，不写进人设。
- **三层来源**：内置档案是分发母本，用户目录 `~/.logox/actors/` 和项目 `.logox/actors/` 可以添加同 ID 的层或全新的角色。项目的 persona/execution/collaboration 追加在用户层之后，不会抹掉已有正文。
- **活动（activity）**：角色的一次任务。每个角色有自己的上下文和队列，同一角色的活动串行，不同角色并发；它们共用文件系统，改同一个文件仍需自己协调。
- **Queue 与 Steer**：Queue 是人工提交、留待之后执行的新任务；Steer 是对某个正在运行的活动插话，绑定到它的活动 ID，不会改投别处。

## 档案的安装与覆盖

1. 构建只把 `src/actors/profiles/` 复制到 `dist`，不碰用户目录。
2. 安装时或执行 `logox --install-profiles`，把缺失的档案复制到 `~/.logox/actors/`，不覆盖已有文件。
3. 运行时从用户目录读取母本，再叠加项目覆盖。
4. `npm run sync:profiles` 会强制替换角色目录，只用于开发，使用前请先备份。

升级时唯一会被自动更新的是 `compression.md`，且仅当内容与已知的旧默认版本完全一致；自定义内容、人设、配置和模型绑定都不动。除目录档案外，也支持带 YAML frontmatter 的单个 Markdown 文件，例如项目 `.logox/actors/scout.md`：

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

修改后在空闲时执行 `/reload`。ID、颜色、编码和大小都要通过校验，路径不允许符号链接；遇到无效定义时保留上一份完整的有效快照，不会只加载一半。`/actors` 查看角色，`/model <actor>` 设置默认模型，绑定写入用户的 `actor-models.json`，未配置时继承会话模型，详见[任务模型](task-models.md)。

角色档案可选定义 `activity_verbs`：按类别（`search`、`read`、`list`、`browse`、`run`）给出 `Gerund/Past` 词汇池，用于工具组标题；缺失的类别回退到默认词汇。`~/.logox/actors/` 中已安装的档案不会被覆盖，需执行 `npm run sync:profiles` 才会获得随版本发布的词汇池。

## 一次派工的流程

1. Logox 判断这是实质工作，调用派工工具，给出简短的标题和一份像对同事交代的任务说明。
2. 派工先登记一个活动，执行时才读取该角色的历史。
3. 角色运行期间，其他角色或 Logox 可以用 `SendMessage` 给它发消息，由它在当前活动内处理，不会另开新任务。
4. 角色结束一轮后，内部的轮次记忆另行保存；正式派工会把完整的任务报告交回 Logox，直接 `@actor` 的请求则是自然回复。报告（及失败记录）交给 Logox 时，运行时会在末尾追加由账本生成的“运行时记录”（改动文件、超出 `owns` 的文件、最近五条 Shell 命令与退出码、轮次关闭方式、验收标准原文），见 `actors/runtime-record.ts:buildRuntimeRecord()`；角色只写自述，事实由运行时记录。
5. 正常完成的任务报告先暂存（`Delivery.hold`），同一根任务下的工作全部结束后才一次性交给 Logox，空闲的 Logox 因此只被唤醒一次；失败、求助和人类输入立即送达，并把暂存的报告一并带上。

Logox 派工后不会阻塞等待自己队列里的后续任务。直接 `@actor` 的对话记录可按需读取，不会整段重复塞进 Logox 的历史。

## 消息与投递

`SendMessage` 默认写入接收方当前活动的收件箱，不等同于 Queue。发给某个角色并要求打断时可以中止它正在运行的工具；发给 Logox 的消息和广播走带优先级的协调事件，不会取消 Logox 正在做的事。角色之间的沟通不等于人工授权。

`DeliveryQueue` 把事件持久登记，并在模型请求的边界记录“已消费”回执：

- 优先级：人工输入先于后台唤醒；故障和求助先于普通报告；同级先进先出。
- 同一时刻已到达的事件在模型边界一并消费，普通的工具活动不会触发新一轮 Logox 调用。
- 正式派工的任务报告按根任务成批送达：同根下仍有排队、运行或等待输入的活动（含 `after` 排队任务、同伴唤醒的返工）时报告保持暂存，不触发唤醒。判定见 `facts.ts:openWork`，释放见 `services.ts:ActorServices.releaseEndedRoots()`；暂停的任务不算未结束，但用户停止某个角色后留下的、等待下一次人类输入的失败记录算。一个成员失败会暂停依赖它的排队任务，失败本身立即送达。Logox 可以用 `ReadActor` 加 `activityId` 提前读取已暂存的报告；暂存的报告仍会在放行时交付。
- 人工停止会阻止自动唤醒；只有新的人工任务真正开始，才一并放出被延后的失败记录和暂存的报告。
- 重启后待处理事件保留，但不会自动请求模型或重跑工具，语义是“至少一次”，不保证副作用只发生一次。

细节见[角色路标](../../src/actors/AGENTS.md)。

## Logox 看到的事实

Logox 的请求里带有一份常驻事实：相关任务的祖先、确切状态、角色自述的标签，每个任务最近最多三条工具结果，一共最多八个任务，其余只说明还有多少。无关的空闲角色不会注入。`ListActors` 可以查看全部角色，对不同调用者给出详细或脱敏的内容。标签和命令成功都不代表任务已验证。

## 取消与失败

- 停止某个角色，只取消它的活动和工具，并暂停依赖它的批次；独立任务不受影响。
- 停止 Logox 不会联动取消角色，晚到的报告会保存，等下一次正式输入处理。
- 正式派工中的技术故障可以回到 Logox 处理，直接发起的任务失败只留在本地。恢复预算（“根任务恢复预算”）按最初的那个根任务计，在不同执行者和重启之间共享。
- 用户停止、认证或额度问题、模型配置错误不会自动补做。
- 恢复只读取状态和进展，不重放已完成的工具；部分成功要连同未完成的工作一起报告。

角色卡片的副标题由运行时从事件推出，不依赖模型是否配合。第一层始终存在：正在运行的工具（与时间线里该工具行相同的标题，如 `Read(a.ts)`；同批多个工具时显示第一个并附 `+N`）或没有工具时的 `Thinking`（流式写工具参数时为 `Writing Edit(file)`），运行超过一秒后附实时计时。第二层在模型提供时叠加：当前这次回复首行的 `⏵ <正在做什么>`，显示为 `<⏵ 文字> · <工具文字>`，卡片变窄时先截断 ⏵ 文字。⏵ 属于写下它的那次回复：角色的下一次回复没有写时，副标题回到第一层；缺失时运行时不提醒、不重试、不强制。思考内容从不进入副标题，角色结束后只剩主标题。⏵ 行只是角色自述，不是验证证据，也不会刷新恢复预算；它也不再回灌给模型（请求历史里没有早先的 `⏵` 行）。账本里的助手消息正文不含该行，`stage` 字段保留它；只有整条回复仅是这一行（没有其他文字、没有业务工具调用）时，这句话作为回复正文保留。

Logox 的协作约定：派出工作的报告会在全部结束后一起到达，或在有紧急消息时提前到达；依赖另一个角色结果的工作在派发时用 `after` 声明，不由 Logox 中途转手。队友的报告里已有截图、控制台检查或测试运行时，Logox 只做一次抽查（打开页面、试一个交互），不重复运行。角色之间用 `reply` 回答 `ask`（不用 `inform`）；发给 Logox 的消息会作为求助立即唤醒它，而任务报告要等批次一起送达：需要决定或发现了会改变计划的紧急情况时才发送，紧急发现不能只写进最终报告，状态不要用它发。浏览器预览：静态页面用 `file://` 打开，只有页面需要 fetch、ES 模块或 service worker 时才在自己的任务里启动自己的本地 HTTP 服务，不跨角色共用。

## 技能

技能可以来自角色目录、frontmatter、角色的 `skills` 列表或显式分配。要用别的角色的技能，直接用 Read 读取对应文件即可，不进入技能列表。技能只提供流程文字，不绕过工具权限，格式见[资源与扩展](resources-and-extensions.md)。

## 边界与限制

- 角色的模型绑定在用户目录，不随项目切换而丢失。
- 没有语义层面的停滞判断：恢复证据按进展指纹去重，不判断任务价值。
- 角色间沟通的规范写在 `src/prompts/collaboration/`，人设里不要重复协作工具的用法。

## 源码入口

- [catalog.ts](../../src/actors/catalog.ts)、[definitions.ts](../../src/actors/definitions.ts)：定义加载与校验。
- [management.ts](../../src/actors/management.ts)：角色管理与模型绑定。
- [ensemble.ts](../../src/actors/ensemble.ts)：调度、取消与任务终态。
- [services.ts](../../src/actors/services.ts)、[collaboration.ts](../../src/actors/collaboration.ts)：派工、消息与技能借阅。
- [recovery.ts](../../src/actors/recovery.ts)：故障预算、暂停与持久交接。
- [delivery-queue.ts](../../src/actors/delivery-queue.ts)、[delivery.ts](../../src/runtime/delivery.ts)：持久投递的约定、优先级与消费回执。
- [facts.ts](../../src/actors/facts.ts)：提供给 Logox 和 `ListActors` 的有界执行观察。
- [ListActors](../../src/tools/coordination/ListActorsTool/prompt.ts)、[SendMessage](../../src/tools/coordination/SendMessageTool/prompt.ts)、[协作提示词](../../src/prompts/collaboration/index.ts)：协作工具的说明与角色间沟通规范。

测试入口：[角色定义](../../tests/actor-definitions.test.ts)、[协作](../../tests/actor-collaboration.test.ts)、[恢复](../../tests/actor-recovery.test.ts)、[Ensemble](../../tests/ensemble.test.ts)、[投递与事实](../../tests/director-facts.test.ts)。
