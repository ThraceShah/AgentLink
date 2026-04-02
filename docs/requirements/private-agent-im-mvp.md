# 个人私有 Agent IM MVP 需求文档

## 1. 产品定义

这个产品是一个面向个人 AI coding 工作流的私有 Agent Control / Messaging Client 系统。

它的核心作用是：

- 让多个动态变化的 agent 以“联系人”形式出现
- 让用户被动收到 agent 的运行状态、完成结果、失败、待确认等消息
- 让用户可以在手机上用接近 IM 的方式向 agent 发送进一步指令

这个产品不是什么：

- 不是通用人际 IM
- 不是远程桌面
- 不是浏览器网页套壳
- 不是完整 IDE
- 不是企业级多租户调度平台

## 2. 核心用户模型

MVP 只有一个用户：系统拥有者本人。

用户特征：

- 已有基于 tmux / SSH / CLI agent 的工作流
- 经常同时跑多个 agent
- 需要在手机端随时查看和轻量干预 agent
- 接受私网部署，不要求公网可访问

## 3. 联系人模型

联系人不是人，而是 agent 实例。

每个 agent 联系人至少包含：

- `agentId`：稳定唯一标识
- `displayName`：可读名称
- `kind`：agent 类型，如 demo、command-task、tmux-bridge、codex-bridge
- `status`：`online` / `busy` / `waiting_input` / `completed` / `failed` / `offline`
- `sessionHint`：可选，表示其关联的 tmux session、任务名或工作目录标签
- `capabilities`：支持的命令能力集合
- `lastSeenAt`：最后活跃时间

## 4. 生命周期到 UI 的映射

agent 生命周期与联系人 / 会话的映射规则如下：

- agent 上线：联系人自动出现，或从离线状态恢复
- agent 首次发消息：会话建立
- agent 运行中：会话中追加状态卡片和日志摘要
- agent 等待确认：联系人状态进入 `waiting_input`，会话中展示操作卡片
- agent 完成 / 失败：会话中展示结果卡片，联系人状态更新
- agent 下线：联系人标记为 `offline`
- 长时间离线 agent：MVP 中保留最近会话，不做复杂归档

## 5. MVP 最小功能集

### 核心链路

- hub 可启动并接受 agent / Android client 连接
- agent 可注册、心跳、下线
- hub 能维护动态 agent 列表
- client 能获取 agent 列表和会话时间线
- client 能通过 WebSocket 接收实时消息
- client 能向 agent 发送基础命令
- agent 能回发状态、文本结果、产物消息

### 消息类型

- 状态消息
- 文本消息
- 日志摘要
- 命令消息
- 产物消息
- 图片消息

### 命令类型

- `status`
- `stop`
- `retry`
- `approve`
- `send_text`

### Android MVP 体验

- agent 列表页
- 会话页
- 状态卡片
- 文本与日志块
- 图片预览
- 快捷命令按钮

## 6. 明确不纳入 MVP 的范围

- 多用户系统
- 复杂权限模型
- 端到端加密体系
- 群聊与人与人聊天
- 消息漫游与长期历史持久化
- 云端中转
- 推送依赖 FCM 的公网通知体系
- 音视频
- 完整文件管理器
- 完整 tmux 终端复刻
- iOS 客户端实现

## 7. 需求结论

MVP 的本质不是“做一个聊天软件”，而是做一个“私网中的 agent presence + timeline + command loop”。

只要能稳定完成以下闭环，就算 MVP 成功：

1. agent 自动出现在列表中
2. 用户能看到其状态流
3. 用户能发最小指令
4. agent 能回结果
5. agent 下线后状态能立即更新
