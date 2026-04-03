# 桌面会话支撑的 Android 模拟器启动需求

## 背景

在纯 SSH 无头环境中直接运行 Android Emulator，容易出现以下问题：

- 启动缓慢
- `System UI isn't responding`
- ADB 输入与 UI 响应不稳定
- 只能依赖纯软件渲染和 TCG，难以完成交互验收

当前主机实际具备：

- 物理机
- 可用的 `/dev/kvm`
- 已登录的 GNOME 桌面会话
- AMD 核显与图形栈

因此 MVP 需要一条比“纯无头 emulator”更稳定的本机模拟器运行路线。

## 目标

- 在 SSH 会话中复用当前用户已存在的桌面会话环境。
- 让 Android Emulator 使用 KVM 加速运行。
- 不要求直接在 SSH 中显示模拟器窗口。
- 优先保证可稳定启动、可 ADB 接入、可完成 App 联调。

## MVP 范围

- 提供一个项目内脚本，自动：
  - 加载 Android SDK 环境
  - 检测当前用户可复用的 Xwayland/Wayland 会话变量
  - 以 `qt-hide-window` 模式启动 emulator
  - 默认启用 `-accel on`
  - 默认使用 `swiftshader_indirect`
- 允许向脚本透传额外 emulator 参数。

## 非目标

- 不管理 Android Studio AVD 图形窗口布局。
- 不自动创建 AVD。
- 不自动处理多模拟器并发冲突。
- 不自动完成 `adb reverse`、APK 安装或 UI 自动化。

## 验收标准

- 在当前主机上可通过项目脚本成功启动 emulator。
- emulator 可在数秒内进入 `device` 状态。
- `package` 服务能正常上线。
- 可继续完成 APK 安装和 App 启动联调。
