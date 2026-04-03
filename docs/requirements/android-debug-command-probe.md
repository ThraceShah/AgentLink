# Android 调试命令探针需求

## 背景

当前 Android 客户端已经可以在 emulator 中打开列表页和会话页，但在无界面 emulator 环境下，`adb shell input tap` 对 Jetpack Compose 按钮的触发不稳定，导致无法稳定完成“点击快捷命令按钮后命令进入 hub 时间线”的自动化验收。

这会阻碍 Android 命令链路的持续联调，但问题主要来自验证环境，而不是核心协议或后端逻辑。

## 目标

为 Android 客户端增加一个仅用于联调和验收的“调试命令探针”能力，使开发者可以通过 `adb am start` 传入调试参数，在应用启动后自动完成一次命令发送。

## 范围

包含：

- 通过 Activity `Intent` extras 注入调试探针配置
- 在连接建立并识别到目标 agent 后自动发送一次命令
- 支持快捷命令和 `send_text`
- 在调试文档中补充触发方法

不包含：

- 通用 UI 自动化框架
- 持久化调试配置
- release 构建下的远程调试入口

## 约束

- 该能力仅用于调试和验收，不应改变正常用户路径
- 仅在 debug 构建中启用
- 默认关闭，只有显式传入参数才会触发

## 验收标准

- 通过 `adb am start` 传入探针参数后，App 启动并自动连接 hub
- 当目标 agent 在线时，客户端会自动向其发送一次命令
- hub 时间线中至少新增一条 `user_command` 事件
- 对于 `status` 或 `send_text`，可以继续观察到 agent 回执事件
