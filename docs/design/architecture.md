# 方案设计与选型

## 1. 目标复述

目标是做一个适合个人使用的私有 Agent IM MVP，优先级依次是：

1. 私网可运行
2. 轻量、低维护
3. Android 原生体验
4. 与现有 tmux / CLI agent 工作流兼容
5. 容易后续接更多 agent 类型

## 2. 候选方案

### 方案 A：中心 hub + WebSocket 实时通道 + HTTP bootstrap / artifact

#### 结构

- 一个轻量 hub 常驻在家庭主机、开发机或 NAS 上
- Android 客户端只连接 hub
- 每个 agent 通过 bridge 连接 hub
- HTTP 用于 bootstrap、健康检查、artifact 下载
- WebSocket 用于实时 presence、timeline、command

#### 优点

- 最符合动态 agent 列表场景
- Android 只维护一个连接，功耗和复杂度都更低
- 容易做联系人上线 / 下线
- 容易做命令转发和统一会话时间线
- 容易扩展到 Web / iOS
- 只需要一个轻量常驻节点，不引入重量级基础设施

#### 缺点

- 引入了一个中心点
- hub 挂掉时所有实时消息中断
- 严格意义上不是完全点对点

### 方案 B：Android 直接连接每个 agent，局域网发现

#### 结构

- agent 各自暴露 HTTP / WS 服务
- Android 通过 mDNS、静态地址或 Tailscale IP 直连每个 agent

#### 优点

- 更接近点对点
- 没有中心节点

#### 缺点

- Android 需要维护多条连接和发现逻辑
- 动态 agent 管理复杂
- 私网跨设备地址变更处理麻烦
- 会话聚合、统一时间线和通知都更难
- Android 后台限制下不适合维护大量连接

### 方案 C：本地消息总线 + 桥接代理

#### 结构

- 主机上引入消息中间件，如 MQTT / NATS
- Android 与 agent 都接入消息总线
- 再额外实现 registry、artifact 服务和会话语义

#### 优点

- 通用性较强
- 理论上扩展能力更好

#### 缺点

- 对个人 MVP 明显过重
- 需要额外组件和运维
- 并不能自然解决“联系人与会话语义”，仍需自建上层

## 3. 推荐方案

推荐采用方案 A：中心 hub + WebSocket 实时通道 + HTTP bootstrap / artifact。

### 推荐原因

- 它是满足需求的最小系统，而不是最“纯粹”的系统
- 它只引入一个轻量中心点，但大幅降低 Android 端复杂度
- 它天然支持 agent 动态上线 / 下线
- 它最适合实现类似 IM 的“联系人 + 会话 + 时间线”
- 它最容易先跑起来，再逐步增加更真实的 bridge 能力

## 4. 推荐方案的组件划分

### Android Client

- 获取 agent 列表和会话 bootstrap
- 维持一条 WebSocket 连接
- 展示联系人列表和会话时间线
- 发送快捷命令和文本指令
- 下载并展示 artifact / image

### Hub

- 保存当前在线 agent 注册表
- 保存内存态会话时间线
- 路由 client -> agent 命令
- 广播 agent -> client 状态与结果
- 保存上传的 artifact 并通过 HTTP 暴露

### Agent Bridge

- 接入真实 agent、shell command task 或 tmux session
- 把运行事件映射为统一协议事件
- 接收 hub 下发的命令并转译为本地动作

## 5. 发现 / 注册 / 下线机制

- agent 启动后主动连到 hub，发送 `hello(agent)`
- hub 为 agent 建立 presence 记录并广播列表更新
- agent 周期性发送 heartbeat
- agent 正常退出时发送 `agent_stopped`
- 连接断开时，hub 将 agent 标记为 `offline`

MVP 不做被动局域网发现，统一采用“agent 主动注册到 hub”。

## 6. 消息与会话抽象

### 联系人层

- `AgentSnapshot`
- 用于列表页、状态摘要和最后活跃时间

### 会话层

- 每个 agent 默认一个主会话
- 时间线由 `TimelineEvent` 组成

### 事件类型

- `agent_started`
- `task_running`
- `task_completed`
- `task_failed`
- `need_user_input`
- `need_approval`
- `artifact_generated`
- `image_available`
- `text_output`
- `agent_stopped`
- `user_command`

## 7. 与 tmux / CLI agent 的集成思路

MVP 先实现两层 bridge：

1. `demo-agent`
   - 用于快速打通注册、消息、命令和 artifact
2. `command-agent`
   - 用于把一个 shell command task 接入系统
   - 通过标准输出中的结构化事件前缀扩展

后续再追加：

- `tmux-bridge`
- `codex-bridge`
- `claude-code-bridge`

## 8. Android 特别设计

### 私网 HTTP / WebSocket / cleartext

- 默认使用 `http://` 与 `ws://`
- 在 Android 中通过 `networkSecurityConfig` 对私网地址允许 cleartext
- 文档中要求仅在局域网 / Tailscale 环境使用
- 后续如用户已有内网 TLS，可以平滑切到 `https://` / `wss://`

### 前台实时连接

- MVP 中，应用前台维持单条 WebSocket
- 若要后台持续接收实时事件，后续可引入前台服务
- 不默认引入后台常驻服务，以避免过早增加系统负担

### 通知机制

- MVP 先做应用内状态与本地通知骨架
- 后续在需要后台常连时，再叠加前台服务 + 本地通知
- 不依赖 FCM

### 列表与会话设计

- 列表页显示 agent 名称、状态、最后消息摘要、最后活跃时间
- 会话页以卡片流展示状态、文本、artifact、图片和操作按钮
- UI 风格贴近 IM，但术语始终使用 agent / task / command，不伪装成社交聊天

## 9. iOS / Web 未来边界

### 值得现在保留的边界

- 协议独立于 Android 实现
- hub 通过通用 JSON over HTTP / WebSocket 暴露
- artifact 采用 URL 访问而非平台专用方式
- command / event 类型采用平台无关枚举

### 现在不值得做的事

- 不为 iOS 提前引入复杂同步层
- 不做跨平台 UI 抽象
- 不做 gRPC、Protobuf、消息队列等更重协议栈

### iOS 的现实限制

- 后台长连接限制更严格
- cleartext 策略更敏感，需要 Info.plist 例外配置
- 纯私网应用分发与调试链路更麻烦

结论：当前协议设计可迁移到 iOS，但 MVP 不为 iOS 增加实现复杂度。
