# 协议定义

MVP 协议采用：

- HTTP JSON：bootstrap、健康检查、artifact 下载
- WebSocket JSON：presence、timeline、command

## 1. HTTP 接口

### `GET /healthz`

返回 hub 健康状态。

### `GET /api/bootstrap`

返回当前 agent 列表与最近会话时间线。

### `GET /artifacts/:agentId/:fileName`

返回 agent 上传的产物文件或图片。

## 2. WebSocket 基础约定

连接地址：

`ws://<hub-host>:8787/ws`

每条消息均为 JSON 对象，包含 `type` 字段。

## 3. 主要消息类型

### `hello`

用于声明连接角色。

角色：

- `client`
- `agent`

### `welcome`

hub 返回的欢迎消息。

### `bootstrap`

hub 返回当前 agent 快照和最近时间线。

### `agent_delta`

agent 在线状态变化。

### `timeline_event`

会话时间线中的一条事件。

### `command`

client 发给 hub，再由 hub 转发给 agent 的命令。

### `heartbeat`

心跳保活。

### `artifact_upload`

agent 上传产物内容，hub 持久化后再转成 `timeline_event` 广播。

## 4. 命令模型

MVP 支持：

- `status`
- `stop`
- `retry`
- `approve`
- `send_text`
- `custom`

## 5. 事件模型

MVP 事件类型：

- `agent_started`
- `task_running`
- `task_completed`
- `task_failed`
- `need_user_input`
- `need_approval`
- `artifact_generated`
- `image_available`
- `text_output`
- `user_command`
- `agent_stopped`

## 6. Android 兼容约定

- cleartext 只在私网环境中启用
- 所有 URL 在文档中都相对于 hub 地址表达
- 图片消息通过 artifact URL 加载
- 时间戳统一使用 ISO 8601 UTC 字符串
