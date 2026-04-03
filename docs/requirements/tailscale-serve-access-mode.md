# Tailscale Serve 接入模式需求

## 背景

当前系统默认通过私网 HTTP 与 WebSocket 直接访问 hub，例如：

- `http://100.x.x.x:8787`
- `ws://100.x.x.x:8787/ws`

在 Android 真机联调中，已经确认以下事实：

- 主机侧 hub 正常监听 `0.0.0.0:8787`
- tailnet ACL 为全放通
- `ShieldsUp` 未开启
- Android 设备可通过 Tailscale SSH 访问主机
- 但 Android 设备对 `http://100.x.x.x:8787/healthz` 的普通 TCP 访问失败，表现为 `No route to host`

这说明：

- 原始 tailnet IP + 自定义端口的访问路径在部分设备上可能不稳定
- 单纯依赖 cleartext HTTP / WebSocket 会增加真机联调摩擦

## 目标

新增一条更稳的私网访问路径，使 Android 客户端在 tailnet 环境中可以不依赖原始 `100.x.x.x:8787` 直接访问 hub。

## 方案要求

- 使用 Tailscale 原生能力，不引入公网云中转
- 仍然只服务于 tailnet 内设备
- 不改变 hub 进程本身的监听端口和部署方式
- Android 客户端应可直接填写新的 hub 地址并工作
- 文档中应明确该模式的适用场景和使用方式

## 推荐方案

使用 `Tailscale Serve` 将本机 `127.0.0.1:8787` 代理为当前节点的 tailnet HTTPS 地址，例如：

- `https://<node>.tailnet.ts.net`

这样可以获得：

- 不依赖原始 `100.x.x.x:8787` 的访问路径
- Android 侧不再受 cleartext 策略影响
- WebSocket 可自动切换为 `wss://`

## MVP 范围

- 配置当前主机的 `Tailscale Serve`
- 验证本机可通过 Serve 地址访问 `/healthz`
- 更新 Android 调试说明和 README
- 记录该模式适用于“原始 tailnet IP 端口访问异常”的场景

## 非目标

- 不引入 Tailscale Funnel
- 不开放到公网
- 不替代默认的私网 HTTP 直连模式
- 不修改 Android 客户端的整体架构
