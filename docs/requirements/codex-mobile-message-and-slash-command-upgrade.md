# Codex 移动端消息与 Slash Command 升级需求

## 背景

当前 Codex 会话已经从早期的 tmux 屏幕捕获演进为 `codex app-server` JSON-RPC 桥接。现有移动端和 Web 原型仍主要消费最终 `text_output`，中间执行过程、审批、模型切换、上下文变化等信息没有形成稳定的移动端消息体验。

这会导致长任务期间用户只能看到忙碌状态，无法判断 Codex 是否仍在推进，也无法回看本轮执行过程。Codex slash command 也只原生支持 `/model`，缺少移动端常用的状态、上下文重置和历史清理入口。

## 目标

- 将 Codex 的一轮请求拆成两类消息：
  - 过程消息：在线时流式更新，完成后折叠为一行摘要，可手动展开。
  - 最终消息：任务完成后独立展示，默认展开，并触发通知。
- 过程消息只展示可观察执行事件，不展示模型隐藏推理链路。
- 离线客户端不补发完整过程流，只在重连后看到持久化的过程摘要和最终回复。
- 保持 Android 旧事件兼容，优先在 Web 原型中验证完整交互。
- 扩展 Codex app-server 模式下的原生 slash command 白名单。

## 功能范围

### Codex 消息策略

- `turn/start` 后产生过程开始事件。
- Codex app-server 的可观察事件映射为过程更新：
  - turn 开始
  - 审批请求
  - 用户输入请求
  - token/context 更新
  - model reroute
  - 中断、失败和完成
- assistant 可见文本 delta 可作为在线草稿更新；最终回复仍以完成态独立消息为准。
- `turn/completed` 后产生过程完成摘要，并单独产生最终回复事件。
- 失败时过程消息完成为失败摘要，同时产生失败事件。

### 持久化策略

- 过程开始、过程增量、assistant 草稿增量为在线 transient 事件，仅广播给当前连接客户端。
- 过程完成摘要和最终回复为持久事件，会进入 Hub bootstrap。
- Web UI 对在线收到的过程增量保留本地详情；如果用户离线重连，只展示持久摘要。

### 通知策略

- 最终回复完成时触发通知。
- 失败、审批、产物仍可触发通知。
- 过程增量不触发通知。
- 空正文等待输入事件不触发通知。

### Slash Command

Codex app-server 模式采用白名单原生实现，不透明转发未知命令。

- `/model`：对齐 Codex 官方语义，列出模型，并在模型选择后继续选择该模型支持的 reasoning effort。
- `/iris-status`：返回当前 session、thread、model、reasoning effort、cwd、approval policy 和 context usage。
- `/iris-new-thread`：创建新的 Codex thread，清理当前 Codex thread 状态，但不删除 Hub session。
- `/iris-clear-history`：清理 Hub 当前 session 的本地时间线，不重置 Codex thread。
- `/iris-help`：列出当前移动端支持的 AgentLink 自定义命令。

## 非目标

- 不展示隐藏推理链路。
- 不把 Codex TUI 的所有 slash command 透明转发给 `turn/start`。
- 不要求 Android 立刻完成同等 UI 重构；本阶段以 Web 原型作为完整验证入口。
- 不保证浏览器关闭后仍能接收过程流或系统通知。

## 验收标准

- Web UI 中 Codex 普通请求会显示一条过程消息和一条最终回复消息。
- 过程消息在线时可持续更新，完成后默认折叠，可展开查看详情。
- 刷新页面后不会恢复完整过程流，但会保留过程完成摘要和最终回复。
- 最终回复完成后触发浏览器通知；过程更新不触发通知。
- Web UI 支持 `/model`、`/iris-status`、`/iris-new-thread`、`/iris-clear-history`、`/iris-help`。
- `/model` 可完成模型与 reasoning effort 两级选择。
- `/iris-clear-history` 后当前 Web timeline 被清空；`/iris-new-thread` 后 Codex 后续消息进入新 thread。
- Hub、协议单元测试和 Web UI 模拟器测试通过。
