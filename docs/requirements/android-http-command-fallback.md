# Android HTTP 命令回退需求

## 背景

当前 Android 客户端已经可以通过 HTTP 完成 bootstrap，通过 WebSocket 接收实时事件，但在 emulator 联调中，客户端向 hub 发送命令的 WebSocket 路径仍不稳定，导致：

- 会话页按钮无法稳定触发命令
- 调试命令探针已经能自动选中 agent，但命令仍未进入 hub 时间线

从现状看，问题集中在 Android 端的命令发送路径，而不是 hub 的事件模型或 agent 处理逻辑。

## 目标

为 hub 和 Android 客户端增加一个轻量的 HTTP 命令通道，作为 Android 命令发送的稳态路径或回退路径，确保：

- Android 客户端在私网环境下可以稳定把命令送入 hub
- hub 能继续把命令路由到在线 agent
- hub 时间线能记录 `user_command`
- 不破坏已有 WebSocket 事件推送模型

## 范围

包含：

- hub 新增 `POST /api/commands`
- Android 客户端改为通过 HTTP 提交命令
- 继续保留 WebSocket 用于事件接收
- 调试文档补充新的验收方法

不包含：

- 完整 REST API 体系
- 鉴权系统
- 批量命令
- 离线命令重试队列

## 设计原则

- 只解决 MVP 中 Android 命令投递的稳定性问题
- 复用现有命令模型，不额外发明第二套命令语义
- 返回值保持简单，便于调试

## 验收标准

- `curl` 调用 `POST /api/commands` 时，hub 时间线中新增 `user_command`
- 在线 agent 能收到命令并回发结果
- Android 调试命令探针通过 HTTP 命令通道后，至少一次成功触发 `status` 或 `send_text`
- Android 仍通过 WebSocket 接收后续的 agent 事件和状态变化
