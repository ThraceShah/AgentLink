# Android HTTP 轮询回退需求

## 背景

当前 Android 客户端已经支持：

- HTTP bootstrap
- WebSocket 实时事件接收
- HTTP 命令提交

但在用户手持真机通过 Tailscale 地址接入时，可能出现：

- HTTP 可用
- WebSocket 未建立
- UI 显示 `Socket: offline`

这种情况下，虽然客户端未必完全不可用，但会丢失实时更新体验，也会给用户造成“系统不可用”的感知。

## 目标

在 WebSocket 未连接时，为 Android 客户端增加一个轻量 HTTP 轮询回退，使客户端仍可：

- 刷新 agent 列表
- 刷新会话时间线
- 继续发送命令

## 范围

包含：

- WebSocket 非 `CONNECTED` 状态下的定时 bootstrap 轮询
- 仅增量追加新的时间线事件
- 连接状态展示保留，但不再让 `Socket: offline` 等价于“功能不可用”

不包含：

- 后台服务常驻
- 推送通知
- 双向强一致同步
- 复杂离线缓存

## 设计原则

- MVP 优先可用性，不为实时性执着到阻塞用户验证
- WebSocket 正常时仍优先使用 WebSocket
- HTTP 轮询只作为回退，不替代实时通道

## 验收标准

- 当 WebSocket 处于 `offline` 或 `connecting` 时，客户端能周期性刷新 bootstrap
- 在没有 WebSocket 的情况下，agent 列表和时间线仍可更新
- 用户通过 HTTP 提交命令后，下一轮轮询可看到新的 `user_command` 与 agent 回执
