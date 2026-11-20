请升级这个配置审计工具（涉及多个模块和分工协作，请合理拆解派工并在最后完整验收）：

1. 把 `src/rules/` 下全部 10 个规则模块从旧接口（`meta` + `check(config)` 返回 `{ valid, reason }`）迁移为新接口：导出 `ruleMeta`（含 `id`、`severity: 'error' | 'warn'`、`title`）和 `evaluate(config)`（返回 `{ passed: boolean, details: string }`），并删掉旧的 `meta` 和 `check`。
2. 升级核心审计引擎（`src/engine.mjs`）、报告模块和命令行入口（`src/cli.mjs`）：
   - `node src/cli.mjs <config.json>` 支持 `--format text|json|markdown`（默认 `text` 保持与现有格式兼容；非法 `--format` 需以非 0 状态码退出并报错）。
   - 支持 `--strict`：默认仅当存在 `error` 级别规则失败时以非 0 退出；加上 `--strict` 后，存在 `warn` 级别规则失败也以非 0 退出。
   - `--format json` 输出合法 JSON 对象，至少包含 `passed`（boolean）、`counts`（`{ total, passed, errors, warnings }`）和 `findings`（数组，每项含 `id`、`severity`、`title`、`passed`、`details`）。
   - `--format markdown` 输出结构化 Markdown 审计报告（包含汇总计数以及各项检查结果）。
3. 补齐 `README.md` 文档，并补充覆盖新规则接口、Markdown/JSON 报告和 `--strict` 行为的测试。
4. 注意：引擎、报告模块与 CLI 之间的内部接口命名与衔接方式由主创之间自行对齐；全部完成后需跑通 `npm test` 并用 `config/sample-good.json` 与 `config/sample-bad.json` 实际验证后再汇报最终结果。
