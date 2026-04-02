# Android 调试说明

## 当前实现路线

- Kotlin
- Jetpack Compose
- OkHttp WebSocket
- Material 3

## cleartext 配置

MVP 允许对私网 hub 使用 cleartext HTTP / WebSocket。

实现方式：

- `AndroidManifest.xml` 开启 `usesCleartextTraffic`
- `network_security_config.xml` 白名单私网网段或调试主机

## hub 地址配置

当前客户端不再把 hub 地址写死在代码里。

MVP 做法：

- 首次启动后在应用顶部输入 hub 地址，例如 `http://100.x.x.x:8787`
- 客户端自动推导对应 WebSocket 地址
- 地址会保存到本地偏好设置

这样做的原因：

- 不把某个私网地址固化在代码中
- 便于在局域网、Tailscale 和模拟器环境间切换
- 更符合个人私有部署场景

## 前台实时连接

MVP 默认仅在应用前台维持 WebSocket。

原因：

- 先降低后台常驻复杂度
- 避免过早引入前台服务
- 先把核心闭环验证清楚

## 若需要后台实时连接

后续可增加：

- 前台服务
- 持久通知
- 重连策略

## 当前验证状态

- 已完成：
  - Node 侧协议与 hub 闭环验证
  - tmux bridge demo 验证
  - Android 客户端代码级联调
  - Android 命令行环境安装
  - `./gradlew :app:assembleDebug` 构建通过

- 当前仍缺少：

- 真机或模拟器联调环境

因此 Android 侧已经可以完成命令行构建，但仍未完成真机或模拟器联网联调。
