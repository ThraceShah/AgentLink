# Codex 移动端消息与 Slash Command 重构计划

## 调研结论

当前 Codex 默认路径为 `TMUX_CODEX_MODE=interactive`，由 `tmux-agent` 启动 `codex app-server`，通过 stdin/stdout JSON-RPC 创建或恢复 thread，并用 `turn/start` 发送用户输入。Codex 输出来自 `item/agentMessage/delta` 累积，现有实现只在 `turn/completed` 后写入 `text_output`。

Hub 协议当前以 `timeline_event` 为主，所有事件默认持久化到内存 store，并通过 bootstrap 返回。Web UI 目前按事件逐条渲染，隐藏 `task_running` 等过程事件，并对 `text_output` 触发通知。

因此本次重构采用兼容式事件扩展：

- 新增过程事件类型与 assistant 草稿事件类型。
- 通过 `metadata.transient` 标记在线流事件，Hub 只广播不持久化。
- Codex 完成后写入持久过程摘要与最终回复。
- Web UI 负责把同一 `processId` 的过程事件合并成一条可折叠过程消息。

## 实施步骤

1. 协议与 Hub
   - 扩展 `eventType`。
   - Hub 对 `metadata.transient === true` 的事件只广播，不写入 store。
   - 增加清理单个 agent timeline 的 HTTP API，供 `/iris-clear-history` 使用。

2. SDK
   - 允许 agent 设置 `metadata` 和新事件类型。
   - 保持 `sendText` 仍发送 `text_output`，兼容 Android。

3. Codex app-server bridge
   - 增加过程回调、assistant delta 回调、thread reset 能力。
   - 保留 reasoning 相关事件 opt-out，不展示隐藏推理。
   - 将 turn、审批、输入、模型、usage、完成等事件转成过程消息。
   - 最终回复仍作为 `text_output` 持久事件。

4. Slash Command
   - 保留官方 `/model`，并对齐模型与 reasoning effort 选择语义。
   - 自定义命令使用 `/iris-status`、`/iris-new-thread`、`/iris-clear-history`、`/iris-help`，避免与官方 Codex slash command 名称冲突。
   - `/iris-clear-history` 调用 Hub 清理本 session timeline。
   - `/iris-new-thread` 重置 Codex app-server thread 状态。

5. Web UI
   - 本地保留 transient 事件，轮询 bootstrap 时不覆盖正在进行的 transient 过程。
   - 过程消息默认在完成后折叠，点击可展开。
   - 最终回复默认展开并触发通知。
   - slash command 面板展示新增命令。

6. 验证
   - TypeScript build 和 Vitest。
   - Hub health check。
   - 通过 Android 模拟器浏览器访问 `/mobile/`，验证创建 session、发送消息、过程折叠、最终通知、slash command、删除 session、刷新恢复。
