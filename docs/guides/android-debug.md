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

若真机已经接入同一个 tailnet，但访问 `http://100.x.x.x:8787/healthz` 仍失败，例如出现 `No route to host`，可改用 Tailscale Serve 暴露出的 HTTPS 地址。该模式属于 tailnet 内访问，不依赖公网中转，但需要在 Tailscale 管理侧先开启 Serve 能力。

推荐填写形式：

- `https://<node>.<tailnet>.ts.net`

客户端会自动把它推导为：

- `wss://<node>.<tailnet>.ts.net/ws`

这条路线的适用场景：

- Tailscale SSH 正常
- 原始 `100.x.x.x:8787` 无法从 Android 浏览器或 App 访问
- 不希望继续依赖 cleartext HTTP

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

## 命令投递调试

当前 Android 客户端已经补充以下调试与可靠性增强：

- Inbox 概览仍显示 WebSocket 连接状态
- 会话页标题下方改为显示 agent 类型、会话状态和连接态圆点
- 前台 WebSocket 已增加应用层心跳与自动重连退避
- App 后台时，收到新的 agent 有效消息会触发系统通知
- 点击系统通知后，会回到 App 并打开对应会话
- 为提高后台提醒稳定性，后台通知由前台服务承担，并通过轻量轮询持续观察新事件
- App 回到前台或收到通知点击 intent 时，会主动向 hub 拉取一次最新 bootstrap，保证会话内容与通知一致
- 连接尚未完成时，命令会先排队，不再静默丢弃
- 连接打开后，排队命令会自动刷新发送
- 关键路径会输出到 `logcat`
- 支持通过 `adb am start` 注入一次性调试命令探针，绕过 headless 模拟点击不稳定的问题
- Android 命令发送改为走 `POST /api/commands`，避免 WebSocket 命令投递在 emulator 联调中不稳定
- 当 WebSocket 未建立时，客户端会自动回退到 HTTP 轮询刷新
- 如果首次连接失败，客户端仍会保留当前 hub 配置，并继续通过 HTTP 轮询自动重试

推荐联调步骤：

```bash
adb reverse tcp:8787 tcp:8787
adb shell am force-stop im.agent.personal
adb logcat -c
adb shell am start -n im.agent.personal/.MainActivity
```

随后可抓取应用进程日志：

```bash
pid=$(adb shell pidof im.agent.personal | tr -d '\r')
adb logcat -d --pid="$pid"
```

需要重点关注的现象：

- App 列表页已加载 agent，说明 bootstrap HTTP 已打通
- Inbox 页若显示 `Live`，说明 WebSocket 已建立
- 会话页若显示绿色连接圆点，说明实时通道已建立
- `logcat` 中若出现 `Heartbeat acknowledged`，说明应用层心跳正常
- 命令发送成功后，hub 时间线中应新增 `user_command`
- 对于 `status` 或 `send_text`，应继续观察到 agent 回执事件
- 若 Inbox 页显示 `Fallback` 或会话页显示离线色圆点，说明实时通道不可用，但客户端仍会通过 HTTP 定时刷新

若当前环境不适合稳定执行 `adb shell input tap`，可以直接使用调试命令探针：

```bash
adb reverse tcp:8787 tcp:8787
adb shell am force-stop im.agent.personal
adb shell am start \
  -n im.agent.personal/.MainActivity \
  --ez debug_probe_enabled true \
  --es debug_probe_agent_id demo-agent \
  --es debug_probe_command status \
  --el debug_probe_delay_ms 1500
```

发送文本指令时可改为：

```bash
adb shell am start \
  -n im.agent.personal/.MainActivity \
  --ez debug_probe_enabled true \
  --es debug_probe_agent_id demo-agent \
  --es debug_probe_command send_text \
  --es debug_probe_text "hello from adb probe" \
  --el debug_probe_delay_ms 1500
```

该探针仅在 debug 构建中启用，默认不会影响正常用户路径。

## 消息复制验证

当前会话页消息支持长按进入可选文本模式：

- 长按消息气泡后，会弹出一个只读文本框
- 默认会选中整条消息文本
- 用户可拖动系统选择光标后执行局部复制

若需要在模拟器中验证该路径，可在会话页对消息区域执行长按，再观察是否出现带 `Done` 按钮的选择对话框。

## 系统通知验证

当前通知策略如下：

- Android 13+ 首次启动会请求通知权限
- 仅对 agent 产生的有效消息发通知
- App 在前台时默认不发系统通知，避免和当前界面重复
- App 在后台时，`text_output`、`need_approval`、`need_user_input`、`task_failed`、`artifact_generated`、`image_available` 会触发通知

在模拟器中可按以下方式自测：

```bash
adb reverse tcp:8787 tcp:8787
adb shell am start -n im.agent.personal/.MainActivity --es debug_hub_origin http://127.0.0.1:8787
adb shell input keyevent KEYCODE_HOME
```

然后向某个 agent 发送一条会产生回复的命令，再用下面命令检查通知：

```bash
adb shell dumpsys notification --noredact | grep -n "im.agent.personal"
```

若要验证点击跳转，可在模拟器通知栏点开对应通知，预期会直接打开对应会话。

若是真机通过 USB + `adb reverse` 联调，应同时覆盖 hub 地址为 `127.0.0.1`：

```bash
adb reverse tcp:8787 tcp:8787
adb shell am start \
  -n im.agent.personal/.MainActivity \
  --es debug_hub_origin http://127.0.0.1:8787 \
  --ez debug_probe_enabled true \
  --es debug_probe_agent_id demo-agent \
  --es debug_probe_command status \
  --el debug_probe_delay_ms 1500
```

## 当前已知限制

在当前无界面 emulator 环境下，`adb shell input tap` 对 Jetpack Compose 按钮的触发并不稳定。当前已经验证：

- agent 列表与会话页可打开
- hub bootstrap 与 WebSocket 建链可继续联调
- 但通过 headless emulator 做完整触控自动化验收，仍存在输入注入不稳定的问题
- 因此当前更推荐使用调试命令探针完成 Android 命令链路验收

这属于当前验证环境限制，不等同于产品协议链路阻塞。若要完成更可信的触控验收，优先建议：

- 使用有图形桌面的本机 Android Studio Emulator
- 或接入一台真实 Android 设备继续联调

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
  - 已补充 Android 连接状态展示、命令排队和 `logcat` 观测能力，便于继续定位命令投递问题

因此 Android 侧已进入可继续进行 APK 安装与联调的状态，但完整 UI 验收仍待继续执行。

## 标准化模拟器自测

项目已提供项目级 Android 模拟器自测 skill：

- `.agents/skills/android-emulator-selftest/SKILL.md`

默认入口脚本：

```bash
./.agents/skills/android-emulator-selftest/scripts/run_selftest.sh
```

该脚本会完成：

1. 构建 debug APK
2. 校验本机模拟器可用
3. 启动临时 hub 与 demo-agent
4. 安装 APK 到模拟器
5. 启动 App 并触发一次 `status` 调试探针
6. 通过 `logcat` 校验命令已被客户端成功发出
7. 刷新 `temp_docs/apk/personal-agent-im-debug.apk`

## Tailscale Serve 回退模式

当 Android 真机满足以下现象时，优先考虑该模式：

- 同一台手机已登录 Tailscale
- 可以通过 Tailscale SSH 到主机
- 但浏览器访问 `http://100.x.x.x:8787/healthz` 失败

可在 hub 主机上执行：

```bash
tailscale serve --bg http://127.0.0.1:8787
```

然后在手机上把 hub 地址改成：

```text
https://<node>.<tailnet>.ts.net
```

注意：

- 若命令提示 `Serve is not enabled on your tailnet`，需要先在 Tailscale 管理侧开启 Serve
- 这一步不是 Android 限制，而是 tailnet 功能开关未启用
