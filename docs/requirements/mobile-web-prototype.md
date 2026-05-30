# 移动 Web 原型客户端需求

## 背景

当前 Android 客户端需要构建、下载并安装 APK 后才能查看交互效果，不利于快速验证移动端信息架构、会话流程、slash command、TUI 弹窗与通知体验。

项目需要一个浏览器可访问的移动 Web 原型客户端，用于在正式 Android 实现前快速验证界面和交互。该客户端不替代最终 Android App，只作为高频迭代和演示入口。

## 目标

- 通过浏览器直接访问 Hub，查看接近 Android 客户端的移动端体验。
- 复用现有 Hub HTTP JSON 与 WebSocket JSON 协议，不引入新的后端业务协议。
- 支持会话列表、会话详情、消息发送、slash command、TUI 菜单选择、特殊按键与会话创建/删除。
- 在浏览器支持时提供 Web Notification 通知能力；不支持或未授权时必须优雅降级。
- 优先保证快速可用和低维护成本，避免引入复杂构建链路。

## 功能范围

### 会话与状态

- 从 `GET /api/bootstrap` 获取 agent 列表与时间线。
- 通过 WebSocket `/ws` 接收 `agent_delta`、`timeline_event`、`tui_menu` 等实时事件。
- WebSocket 断开时保留 HTTP 轮询兜底。
- 展示连接状态：`Live`、`Syncing`、`Fallback`。

### 会话详情

- 支持从会话列表进入单个会话。
- 展示用户命令、agent 文本、审批/输入提示、产物图片或文件链接。
- 默认隐藏 `agent_started`、`agent_stopped`、`task_running`、`task_completed` 等过程事件。
- 支持复制消息正文。

### 命令与输入

- 普通文本通过 `POST /api/commands` 发送 `send_text`。
- 输入 `/` 时显示当前 agent 下发的 `slashCommands`。
- 匹配 slash command 后按其 `commandType` 执行：
  - `send_text`：向 agent 发送原生命令文本。
  - 其他命令类型：作为 command type 发送。
- 支持常用特殊按键：方向键、Enter、Esc、Tab、Backspace，以及单字符按键。

### TUI 弹窗

- 收到 `tui_menu` 后显示移动端弹窗。
- 支持普通菜单项选择、取消、确认和输入型菜单项。
- 选择结果通过 WebSocket 发送 `tui_menu_select`。

### 会话管理

- 支持读取 `GET /api/agent-profiles` 与 `GET /api/session-config`。
- 支持通过 `POST /api/sessions` 创建会话。
- 支持通过 `POST /api/sessions/delete` 删除会话。

### Web 通知

- 浏览器支持 Notification API 时，允许用户手动开启通知。
- 仅在页面已授权且收到新的 agent 消息、审批请求、失败或产物事件时触发浏览器通知。
- 移动端浏览器后台通知能力不稳定，不作为可靠后台通知方案。

## 非目标

- 不实现原生 Android 后台前台服务能力。
- 不保证浏览器关闭后仍能收到通知。
- 不引入用户账号、权限系统或独立 Web 后端。
- 不替代 Android 客户端的最终系统通知、离线能力和系统集成。

## 验收标准

- 访问 `http://<hub-host>:8787/mobile/` 能打开移动 Web 原型。
- 能看到当前 Hub 中的会话列表，并进入会话查看消息。
- 能发送普通文本并收到 agent 回复。
- 能输入 `/model` 等当前 agent 支持的 slash command，并展示/执行对应菜单。
- 能处理 `tui_menu` 弹窗并回传选择。
- Hub 断开 WebSocket 后，页面仍能通过 HTTP 轮询刷新。
- 在支持 Notification API 的浏览器中，可开启并触发前台通知。
