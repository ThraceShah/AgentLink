# 变更日志

本文档记录项目中已完成功能、重要修复、兼容性调整和显著行为变更。

## Unreleased

- 初始化变更日志文档。
- 完成“个人私有 Agent IM”MVP 的需求建模、方案设计与分阶段实施计划。
- 建立 monorepo 工程骨架，加入 hub、共享协议、Node SDK、demo agent、command agent 和 Android 原生客户端骨架。
- 实现最小闭环：agent 注册、动态列表、状态时间线、命令下发、结果回传、图片产物上传与下线状态更新。
- 补充基础单元测试、hub 集成测试和本地 demo 脚本。
- Android 客户端改为支持可配置 hub 地址，并修正 artifact 图片 URL 的动态拼接。
- 新增第一版 tmux bridge，支持 session 绑定、pane 输出摘要、approval 检测和基础命令映射。
- 安装并验证 Android 命令行构建环境，补充 Gradle wrapper，并完成 `assembleDebug` 自测。
