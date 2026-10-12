# LOGOX TS 协作约定

## 用户沟通

- 使用直白、通俗的中文。先回答当前问题，再解释相关机制、代价和实际代码位置。
- 解释围绕 LOGOX 的角色调度、Agent 循环、工具、上下文、错误恢复与舞台交互，明确区分已实现、设计中和未验证。
- 回答范围与用户问题一致；用户已知背景不反复强调。
- 产品体验与技术路线的未决选择给出具体选项、优缺点、建议和改变成本，由用户参与确认。已确认工作继续推进。

## 项目主线与读取入口

- 本项目整体使用 TypeScript，围绕 Anamnesis 入梦与剧团式 subagent 设计，默认使用 fullscreen。状态卡片与异步交互卡片通过运行时协议复用。开发和设计先核对 [迁移总览](docs/development/designs/2026-10-11-typescript-migration.md)，按[专题索引](docs/README.md#专题设计与复盘)读取当前功能的设计。
- 开发、修复、重构或维护文档时，读 [WORKFLOW](docs/development/WORKFLOW.md) 和 [STATUS](docs/development/STATUS.md)，再按[模块入口](docs/modules/README.md)读取相关源码、测试和当前设计；修改 UI 时另读 [UI-SPEC](docs/UI-SPEC.md)。
- 文档随功能推进维护：当前说明原地改写，设计按主题归类；完成前清理失效内容、重复规则和已完成待办，运行 npm run check:docs 并核对内容与实现，整理是交付条件。
- 流程、设计确认时机、代码维护和文档归属由 WORKFLOW 维护；先文档后代码，已确认且已授权的工作持续推进。验证和交付时读 [TESTING](docs/development/TESTING.md)，完成后改写当前说明和剩余工作。
- 原 LOGOX 的当前源码、文档和测试是迁移行为的参考。新设计与实现落在本项目；保留原项目及其未提交修改。
- LEGACY/legacy 目录及明确标为 legacy 的材料不读取、不修改、不作为设计或验证依据。
- Director、Actor、权限与恢复规则由运行时负责，界面负责呈现和输入。公共接口与依赖方向在相关设计中确认，现行机制在模块文档维护。
- 保护凭据、私人会话、原始资料和运行状态。提交、推送、合并和外部发布按用户授权执行。
