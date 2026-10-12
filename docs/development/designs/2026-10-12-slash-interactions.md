# Slash 命令联想、选择器与页签页面

日期：2026-10-12。

状态：已实现，自动验收结果见下；真实 Windows Terminal 待现场验收。用户要求参考 Claude Code 的 picker、tab 页面与共享容器；保留当前 LOGOX 配色、❯ 选择与全屏舞台。完整 Actor 管理属于后续剧团阶段，见[持久角色设计](2026-10-12-persistent-actors.md)。

## 命令联想与确认

共享 commands 元数据维护名称、用途与参数类别，application 执行业务。输入区以 / 开始时按前缀显示公开候选；方向键选择，Tab 补齐，Enter 执行可无参数命令或打开界面，必填参数先补齐。参数候选 Enter 只补齐，再次 Enter 提交；Esc 保留草稿，编辑后重新联想。无候选时 Tab 保留审批聚焦，Shift/Alt+Enter 仍换行。

/login、/provider 补全提供商，/model 补全当前模型、已查询列表与“提供商/模型”候选。键入不请求网络，登录密钥、自由回答、多行正文不显示菜单。参考 PI editor/autocomplete 的输入顺序，保留 LOGOX 绿色高亮与 ❯。

## 行为与职责

- 无参数 /model 打开模型 picker，/provider 与 /providers 打开提供商 picker。/login 的提供商阶段复用相同 picker，密钥阶段保留独立遮罩输入。直接传参数仍执行对应操作。
- /status、/config、/help 打开同一个页签页面，分别定位状态、配置、命令。配置页展示当前真实参数；本轮不添加配置写入或未经实现的用量数据。
- Picker 放在输入区位置，上方舞台仍可读；支持上下、Home/End、分页、搜索、Enter 确认、Esc/Ctrl+C 关闭。页签页面使用舞台大小，左右/Tab 切换，上下/分页浏览，Esc/Ctrl+C 返回。Ctrl+D 仍关闭应用。
- 组件接收标题、说明、选项/页签、当前项、空状态及回调；容器负责尺寸与共享视觉，业务层负责候选、认证、选择校验与结果。主输入草稿、角色窗口、审批与阅读位置不由命令页面改写。
- 命令完成以明确结果交还应用，选择成功才改变模型；取消不改变选择、不写模型账本、不触发模型调用。查询与保存有身份及取消边界，旧查询结果不能重新打开已关闭界面。
- 主 /model 与未来 Actor 模型选择共用提供商 + 模型 ID 目录。只查询具有认证来源、已配置本地或显式无需认证接口的提供商；某厂商失败不阻止其他列表返回，键入搜索只筛选已加载列表。选择角色模型的完整入口仍留在剧团阶段。

## 源码参考与验收

本机 CC 的 types/command.ts 定义 local-jsx 与 onDone；commands/status/status.tsx 使用 Settings(defaultTab)，commands/model/model.tsx 包装 ModelPicker。Settings/Settings.tsx 组合 Pane + Tabs，CustomSelect/select.tsx 提供选项与导航配置。采用容器、组件与完成结果的分工，保持运行时协议独立于 React；不照搬厂商模型别名、私有状态、颜色或未使用的完成字段。

实现后验收：实际 Ink 输入接线、picker 搜索与同名模型跨提供商选择、页签导航/滚动、关闭恢复草稿、查询取消和失败、忙中切换拒绝、密钥遮罩、窄矮窗口；运行类型检查与必要全量回归，再改写当前说明。

## 实现与验收结果

2026-10-12，当前未提交工作树。实现入口为 [CommandSurfaces](../../../src/commands/surfaces.ts)、[CommandPane](../../../src/tui/command-pane.tsx)、[Picker](../../../src/tui/picker.tsx)、[TabbedPage](../../../src/tui/tabbed-page.tsx)、[application](../../../src/application.ts) 和 [ProviderRegistry](../../../src/providers/registry.ts)。完成结果只传当前需要的通知文本；取消不产生结果，业务回调不进入快照。统一目录沿用真实 /models 接口和认证，单家查询限时 15 秒；搜索不请求网络。同名模型的提供商在窄屏中保留显示空间。

实际 Ink 模拟 TTY 与隔离 HTTP 服务验证了搜索、禁用选项、Home/End/分页、跨提供商切换、取消、页签导航/滚动、32×10 缩放、草稿/阅读位置/审批焦点恢复、查询取消、旧响应隔离、部分失败、忙中确认拒绝、登录遮罩和 Ctrl+D 退出。/status、/config、/help 仅展示当前数据，没有模型调用或 Journal 写入。

验证：npm run check 通过；npm test（包含构建）77 项全部通过，零失败。真实厂商的 /models 目录和实际 Windows Terminal 字体、透明度、输入法未在本轮重测；现场步骤见 [TESTING](../TESTING.md)。当前使用与界面说明已同步到 [USAGE](../../USAGE.md)、[UI-SPEC](../../UI-SPEC.md) 和[模块地图](../../modules/README.md)。完整角色模型管理按[持久角色设计](2026-10-12-persistent-actors.md)后续接入。
