# 连续回复触发布局更新循环的修复

日期：2026-10-12。状态：离线回归已通过；用户真实 Windows Terminal 的致命退出仍待重试。

## 触发与定位

正式舞台发送“你好”后，用户报告 Maximum update depth exceeded，调用栈进入 Ink use-box-metrics 的 setState。离线 App + RuntimeStore 连续发布 160 段文本可稳定捕获同类更新深度错误，慢速分片不触发；旧 act 测试未覆盖同一事件循环的快速分片。

停用两处 useBoxMetrics 后复现通过。正式舞台没有挂载对应的普通卡片测量节点，测量仍在每次提交后设置状态；相同高度更新导致重复渲染。

## 修复与保持范围

[useContentHeight](../../../src/tui/metrics.ts) 仅在提交布局后的高度确实改变时更新状态，保留普通卡片的实际高度与滚动。模型消息、持久化和提交语义保持原样。

## 回归证据

将回归缩减至 80 分片后，临时恢复旧测量仍稳定失败，恢复修复则通过。[tui-stream.test](../../../tests/tui-stream.test.tsx) 有意不使用 act，检查同批思考/文本、完整尾段、再次发送与缩放；另有完整 Application → Agent → Journal → Ink 的离线快速分片验收。

2026-10-12 当次 npm test 构建及 71 项通过。离线捕获的是 React 更新深度提示，尚未现场复现用户的进程致命退出。重试 npm start -- --session morning-check，发送两条连续消息并缩放，方法见 [TESTING](../TESTING.md)。同时开发的命令联想归[slash 专题](../designs/2026-10-12-slash-interactions.md)。
