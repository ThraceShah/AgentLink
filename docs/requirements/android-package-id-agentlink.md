# Android 包名切换到 AgentLink 需求

## 背景

当前 Android 客户端的显示名称已经改为 `AgentLink`，但 Android 包名仍保持早期的 `im.agent.personal`。这会导致系统级标识、adb 调试命令和应用身份仍然带有旧命名。

## 目标

- 将 Android 应用包名统一切换为 `im.agent.link`。
- 保持现有功能行为不变。
- 同步更新本地自测脚本和调试文档中的 adb 命令。

## MVP 范围

- 修改 Android `namespace`
- 修改 Android `applicationId`
- 修改 Kotlin 源码中的包声明
- 修改项目内 Android 自测脚本使用的 `APP_ID`
- 修改文档中的 adb 包名示例

## 非目标

- 不修改应用显示名称，本次显示名称继续保持为 `AgentLink`
- 不调整 Android UI、通知逻辑或协议结构
- 不迁移仓库目录名

## 验收标准

- APK 的 application id 为 `im.agent.link`
- 调试命令可使用 `im.agent.link/.MainActivity`
- Android 模拟器标准自测通过
- 项目内文档与脚本不再引用旧包名 `im.agent.personal`
