# Hub Docker 镜像与系统服务需求

## 背景

Hub 是 AgentLink 的核心服务，负责客户端连接、agent 注册、会话时间线、命令转发和本机 tmux-backed provider 会话创建。当前开发机需要让 Hub 以系统服务方式运行，并在开机后自动启动。

## 目标

- 提供 Hub Docker 镜像构建入口。
- 提供 systemd 系统服务配置，使 Hub 不依赖用户登录会话即可开机启动。
- 服务默认监听 `0.0.0.0:8787`，保持现有 Android 与私网联调入口不变。
- 保留 Hub 创建本机 `tmux`、`codex`、`qwen`、`opencode`、`copilot` 会话的能力。
- 提供一键更新脚本，便于后续开发后快速重新构建镜像、刷新服务并验证健康状态。

## 方案约束

- Docker 容器使用 host network，避免 Android、Tailscale 与 WebSocket 调试路径变化。
- 容器使用镜像内的 `/app` 代码与依赖运行，仅持久化挂载 `data/`，并挂载用户 home 到同一路径，确保 Hub 可以访问本机 provider 配置、workspace 与 tmux 相关环境。
- 容器以当前开发用户 UID/GID 运行，避免生成 root-owned 项目文件。
- systemd 单元安装到系统级服务目录，由 `multi-user.target` 管理。
- 更新脚本应支持重复执行，执行后必须验证 `/healthz`。
