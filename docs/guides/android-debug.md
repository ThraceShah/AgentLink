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

- Android 模拟器默认使用 `http://10.0.2.2:8787` 作为 hub 地址
- 首次启动后在应用顶部输入 hub 地址，例如 `http://100.x.x.x:8787`
- 客户端自动推导对应 WebSocket 地址
- 地址会保存到本地偏好设置

这样做的原因：

- 不把某个私网地址固化在代码中
- 便于在局域网、Tailscale 和模拟器环境间切换
- 更符合个人私有部署场景

其中：

- Android Emulator 访问宿主机应使用 `10.0.2.2`
- 若当前 emulator 环境对 `10.0.2.2` 不可达，可执行 `adb reverse tcp:8787 tcp:8787`
- 在 emulator 环境下，客户端会在 `10.0.2.2` 失败后回退尝试 `127.0.0.1`
- 真机或局域网设备应填写宿主机实际私网地址或 Tailscale 地址
- 若使用 adb 反向代理，也可以改填 `http://127.0.0.1:8787`

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

## 本机模拟器运行建议

如果当前主机已经有登录中的 GNOME 桌面会话，而你又是通过 SSH 进入主机，优先使用项目脚本启动 emulator：

```bash
scripts/android/start-emulator-desktop.sh
```

这条路线会：

- 复用当前用户桌面会话中的显示环境
- 启用 KVM 加速
- 使用 `qt-hide-window` 避免在 SSH 中依赖直接显示窗口
- 比纯 `-no-window + -accel off` 更适合继续做联调

脚本支持透传附加参数，例如：

```bash
scripts/android/start-emulator-desktop.sh project_iris_api35 -wipe-data
```

若需要让 emulator 内的 `127.0.0.1:8787` 指向宿主机 hub，可继续执行：

```bash
adb reverse tcp:8787 tcp:8787
```

## 当前验证状态

- 已完成：
  - Node 侧协议与 hub 闭环验证
  - tmux bridge demo 验证
  - Android 客户端代码级联调
  - Android 命令行环境安装
  - `./gradlew :app:assembleDebug` 构建通过

- 当前仍缺少：
  - 完整的 App 内 UI 自动化验收

- 当前新增进展：
  - 已在无界面 Android Emulator 上完成设备启动与 ADB 连接验证
  - 已补充模拟器默认 hub 地址为 `10.0.2.2:8787`
  - 已补充 emulator 环境下的 `127.0.0.1` 回退连接逻辑，便于配合 `adb reverse` 联调
  - 已新增桌面会话支撑的 emulator 启动脚本，便于在 SSH 会话中复用本机 GNOME 图形环境和 KVM 加速

因此 Android 侧已进入可继续进行 APK 安装与联调的状态，但完整 UI 验收仍待继续执行。
