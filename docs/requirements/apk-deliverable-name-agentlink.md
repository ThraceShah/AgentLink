# Android 交付 APK 命名统一为 AgentLink 需求

## 背景

当前 Android 应用名称和包名都已经切换到 `AgentLink`，但标准交付 APK 文件名仍然沿用早期名称 `personal-agent-im-debug.apk`，与当前产品命名不一致。

## 目标

- 将标准交付 APK 文件名统一为 `agentlink-debug.apk`
- 同步更新项目内自测脚本和正式文档中的交付路径引用

## MVP 范围

- 修改项目级 Android 模拟器自测 skill 的目标 APK 路径
- 修改 Android 调试文档中的交付 APK 路径
- 刷新新的交付 APK 文件
- 删除旧文件名的交付 APK，避免混淆

## 非目标

- 不修改 Gradle 默认产物文件名 `app-debug.apk`
- 不改动 Android 构建逻辑
- 不回写历史临时回复文档

## 验收标准

- `temp_docs/apk/agentlink-debug.apk` 存在且为最新构建产物
- 项目正式文档和 skill 文档不再引用 `temp_docs/apk/personal-agent-im-debug.apk`
- Android 模拟器标准自测通过
