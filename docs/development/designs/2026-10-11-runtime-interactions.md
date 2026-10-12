# 运行时活动与异步交互

建立日期：2026-10-11。维护日期：2026-10-12。状态：协议、队列和 demo 接线已实现；完整入梦研究与持久检查点待迁移。

本文说明 Actor 与 Anamnesis 如何共用运行状态和提问机制，以及舞台如何呈现这些结果。终端视觉见[舞台设计](2026-10-11-terminal-ui.md)，真实模型与工具见[Agent 设计](2026-10-12-agent-tools.md)。

## 目标与职责

入梦与剧团共同影响运行时结构。两者共用活动身份、阶段、细节和终态；权限审批与 Agent 问题共用异步请求生命周期。提问只暂停所属任务，舞台仍接收输入和排队工作。

运行时是任务、回答和取消结果的权威。TUI 负责投影快照、提交回答，维护窗口、草稿、折叠和阅读位置。脚本 demo 与正式模型入口使用同一协议，执行器各自装配。

## 活动与请求

活动由 sessionId、activityId、ownerId 定位，同一活动更新同一卡片。状态包含 queued、running、waiting_input、paused、completed、failed、cancelled；终态不会因重绘再次运行。

交互带独立 requestId，绑定原活动和所有者。问题包含稳定 questionId、标题、问题、选项说明和自由文本；多问题逐项回答。权限包含工具、实际参数和原因，当前仅提供本次允许与拒绝，默认拒绝。

交互中心发布请求并返回完成 Promise。回答校验身份、问题覆盖和选项；无效或重复回答不解除等待。稍后回答只转移焦点或收起卡片，取消请求、取消任务与关闭分别解除相应等待；权限取消表示没有获得许可。

## 队列、窗口与取消

同一会话中每位角色只有一个独立上下文，同批同角色任务合并，角色按舞台顺序串行执行。接受任务时发布用户输入、来源窗口和 activityId；排队不提前生成回复。

主窗口 @角色与独立角色窗口走同一提交入口、引用同一次任务。两个窗口回答同一个 requestId，运行时裁决一次后同步呈现。独立角色的完整长期配置见[持久角色设计](2026-10-12-persistent-actors.md)。

排队取消立即发布终态并解除其完成等待，轮到时跳过。回复保存结束后检查取消信号，避免取消期间保存结束被误报为完成。关闭释放正在等待和排队的任务。

## 入梦生命周期与 demo

现有 Anamnesis 接线维护空闲资格、草稿刷新、前台提交暂停、同活动续做和关闭。只读 runner 不获得写工具或权限询问。研究进度、来源、提案、用户运行锁和持久检查点仍待完整业务迁移。

作品集 demo 中，Aletheia 的检查是已有样本，Techne 等待演示许可，Kalon 排队并询问偏好；裁决、自由回答、取消和收尾来自真实 RuntimeStore。允许演示方案没有执行文件工具，偏好候选没有提交长期档案。

## 实现与验收

入口：[contracts](../../../src/runtime/contracts.ts)、[activities](../../../src/runtime/activities.ts)、[interactions](../../../src/runtime/interactions.ts)、[store](../../../src/runtime/store.ts)、[Ensemble](../../../src/actors/ensemble.ts)、[Anamnesis](../../../src/anamnesis/service.ts)、[场景投影](../../../src/tui/scene-state.ts)。

已验证：活动不重复、身份隔离、完整回答校验、等待期间排队、允许/拒绝与自由回答、跨窗口同步、取消与保存竞态、关闭释放等待、入梦暂停/续做。对应测试为 [interactions](../../../tests/interactions.test.ts)、[ensemble](../../../tests/ensemble.test.ts)、[demo](../../../tests/demo.test.ts)、[anamnesis](../../../tests/anamnesis.test.ts) 和 [app](../../../tests/app.test.tsx)。

2026-10-12 已有自动回归通过；实际 Ink 100×55、40×85 的场景输出检查覆盖卡片、悬停、多行输入和偏好候选。真实 Windows Terminal 的输入法、透明合成与系统剪贴板仍待现场验收，入口见 [TESTING](../TESTING.md)。完整入梦研究、长期档案提交和跨进程恢复见 [STATUS](../STATUS.md)。
