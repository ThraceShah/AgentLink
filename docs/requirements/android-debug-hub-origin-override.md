# Android 调试 Hub 地址覆盖需求

## 背景

当前 Android 客户端默认 hub 地址为 `http://10.0.2.2:8787`，这适用于 Android Emulator 访问宿主机，但不适用于通过 USB + `adb reverse` 联调的真实 Android 设备。

真机联调时，即使 `adb reverse tcp:8787 tcp:8787` 已生效，客户端若仍使用 `10.0.2.2`，也无法正确连接到本机 hub。

## 目标

为 Android debug 构建增加一个仅用于联调的 hub 地址覆盖能力，使开发者可以通过 `adb am start` 显式指定本次启动所使用的 hub origin，例如：

- `http://127.0.0.1:8787`

## 范围

包含：

- 通过 Activity `Intent` extras 注入调试 hub origin
- 启动时覆盖当前 UI 状态中的 hub 地址
- 与现有调试命令探针组合使用

不包含：

- release 构建下的远程配置
- 多地址配置管理
- 自动识别 USB reverse 状态

## 验收标准

- debug 构建中，通过 `adb am start ... --es debug_hub_origin http://127.0.0.1:8787` 启动应用
- 客户端使用该地址完成 bootstrap 和实时连接
- 可与调试命令探针组合，完成真机命令链路验收
