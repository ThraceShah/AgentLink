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
- 调整 Android 模拟器默认 hub 地址为 `10.0.2.2:8787`，并补充模拟器 cleartext/宿主机联调说明。
- 新增 Android Emulator hub 连接回退逻辑：在 emulator 环境下，`10.0.2.2` 失败后可回退到 `127.0.0.1`，便于配合 `adb reverse` 联调。
- 新增桌面会话支撑的 emulator 启动脚本，可在 SSH 会话中复用本机 GNOME 图形环境并启用 KVM 加速。
- 新增 Android WebSocket 连接状态展示、命令排队和 `logcat` 调试日志，修复模拟器联调中命令投递静默失败的残留问题。
- 新增 Android 调试命令探针，可通过 `adb am start` 自动触发一次命令发送，用于绕过 headless emulator 模拟点击不稳定的问题。
- 新增 `POST /api/commands` 与 Android HTTP 命令回退通道，解决 emulator 联调中 Android WebSocket 发送命令不稳定的问题。
- 新增 Android debug hub 地址覆盖能力，支持真机通过 `adb reverse` 使用 `127.0.0.1` 连接本机 hub。
- 新增 Android HTTP 轮询回退，使 WebSocket 离线时仍可刷新 agent 列表与时间线。
- 修复 Android 首次 bootstrap 失败后的恢复路径，使 HTTP 轮询可继续自动重试当前 hub。
- 新增 Tailscale Serve 回退接入文档，用于处理 Android 真机可 SSH 但无法直连 `100.x.x.x:8787` 的场景。
- 重构 Android 客户端为更接近 IM 的移动端界面，改用单列会话列表、独立会话页、状态胶囊和底部输入区。
- 完成 Android 客户端第二轮 UI 精修，补充 Inbox 状态摘要、会话卡片强化标签和更清晰的时间线类型标签。
- 修复 Android 会话默认滚动方向，进入会话页时优先定位到最新消息，并精简时间线中的协议标签展示。
- 将示例 agent 从回声逻辑升级为 OpenAI bridge；未配置 `OPENAI_API_KEY` 时会明确提示缺失条件。
- 增强 `tmux-agent` 为第一版 Codex bridge，支持 `codex` profile、增量输出提取、最近有效回复缓存和基础提示识别。
