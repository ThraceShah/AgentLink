# Hub 本机系统服务需求

## 背景

Hub 是 AgentLink 的核心服务，负责客户端连接、agent 注册、会话时间线、命令转发和本机 tmux-backed provider 会话创建。当前开发机需要让 Hub 以系统服务方式运行，并在开机后自动启动。

此前曾尝试通过 Docker 容器运行 Hub，但容器环境会隔离宿主机 CLI、认证配置、动态链接运行时和 tmux 环境，导致 Hub 无法稳定发现并启动 `opencode`、`codex`、`qwen`、`copilot` 等本机 provider。因此 Hub 部署方式收敛为直接使用宿主机 Node.js 后端服务。

## 目标

- 提供 systemd 系统服务配置，使 Hub 不依赖用户登录会话即可开机启动。
- 服务默认监听 `0.0.0.0:8787`，保持现有 Android 与私网联调入口不变。
- 保留 Hub 创建本机 `tmux`、`codex`、`qwen`、`opencode`、`copilot` 会话的能力。
- 提供一键更新脚本，便于后续开发后快速安装依赖、构建项目、刷新服务并验证健康状态。

## 方案约束

- Hub 直接在项目目录中运行 `node_modules/.bin/tsx apps/hub/src/server.ts`。
- systemd 服务使用当前开发用户和用户组运行，避免生成 root-owned 项目文件。
- 服务环境显式设置 `HOME`、`USER`、`LOGNAME`、`HUB_HOST`、`HUB_PORT`、`HUB_DATA_DIR` 和 `SESSION_WORKDIR_ROOT_RELATIVE`。
- 服务 `PATH` 应包含用户级 CLI 目录，例如 `~/.opencode/bin` 与 `~/.local/bin`，确保 Hub 能发现本机 provider CLI。
- systemd 单元安装到系统级服务目录，由 `multi-user.target` 管理。
- 更新脚本应支持重复执行，执行后必须验证 `/healthz`。
