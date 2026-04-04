# AgentLink

一个运行在局域网、Tailscale tailnet 或其他私网中的个人私有 Agent IM 原型系统，产品名为 `AgentLink`。

它不是通用 IM，也不是远程桌面，而是一个面向“你”和“多个动态变化的 code agents”之间的轻量消息与控制系统。

## 当前 MVP 范围

- 轻量 hub：负责 agent 注册、在线状态、会话时间线和命令转发
- Node.js agent bridge：负责把 shell command task 或 tmux-backed CLI agent 接入 hub
- Android 原生客户端骨架：Jetpack Compose + OkHttp WebSocket
- tmux bridge：把 tmux session / pane 接入为可控制 agent
- tmux bridge 现已支持 `opencode` profile，但仅在本机真实 OpenCode 配置可用时才会显示
- tmux bridge 现已支持 `codex` profile，可直接作为本机 Codex bridge 使用
- tmux bridge 现已支持 `copilot` 与 `qwen` profile
- `codex` profile 默认走稳定的 `codex exec` 模式，已完成真实端到端验证
- `copilot` 与 `qwen` profile 已完成本机端到端验证
- `opencode` profile 不再伪装复用 `qwen`，而是直接调用本机真实 `opencode` CLI
- Android 发送消息时支持本地乐观入列，用户消息不再等 agent 回复后才出现
- `qwen` 与 `copilot` 已接入 JSON bridge 解析路径；exec profile 会在 provider 完成后统一向 Android 投递最终消息，避免未完成回复被提前显示
- Android 首页会按最后一次真实对话时间排序，不再被 heartbeat 保活时间污染
- Android 会话页中的 agent 消息标签会按消息实际模型显示，例如 `gpt-5.4`、`glm-5`
- 协议与架构文档
- 本地 demo 脚本与基础测试

## 为什么采用这个方案

- 只需要一台私网可访问主机运行 hub
- Android 只连接 hub，不直接管理多个 agent 地址
- agent 动态出现和消失可以自然映射为联系人上下线
- WebSocket 足够轻，适合实时状态与命令回传
- HTTP 只承担 bootstrap 和 artifact 下载，不引入复杂基础设施

## 目录结构

```text
.
├── AGENTS.md
├── README.md
├── android-client/
├── apps/
│   └── hub/
├── agents/
│   └── command-agent/
├── docs/
├── packages/
│   ├── protocol/
│   └── sdk/
├── scripts/
│   └── demo/
└── tasks/
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动 hub

```bash
npm run dev:hub
```

默认监听：

- HTTP: `http://0.0.0.0:8787`
- WebSocket: `ws://0.0.0.0:8787/ws`

### 3. 启动 tmux bridge

```bash
npm run dev:tmux-agent
```

### 4. 运行最小 demo

```bash
npm run demo
```

### 5. 运行 tmux bridge demo

```bash
npm run demo:tmux
```

### 6. 运行 Codex bridge

```bash
npm run dev:codex-bridge
```

## Android 客户端说明

Android 客户端当前提供：

- agent 列表
- IM 风格的会话列表与单列会话页
- 联系人主标题直接使用 tmux 会话名
- 会话时间线
- Inbox 概览摘要与更清晰的状态层级
- 会话删除
- 首页会话卡片支持长按操作
- 文本指令发送
- slash command 输入，例如 `/status`、`/retry`、`/stop`
- 用户消息即时显示
- 首页会按最后一次真实对话时间倒序排列
- agent 消息标签按每条消息的实际模型显示
- 会话页底部会显示当前会话的运行态信息，例如当前模型与最近一次上下文使用量
- 会话卡片与消息气泡支持长按复制
- 首页新增会话入口，可直接创建新的 tmux-backed agent 会话
- 首页新增会话入口会按当前机器真实可用的 profile 展示
- 若本机真实 OpenCode 配置可用，则新建会话默认优先选中 `opencode`
- 首页左上角显示当前连接主机的用户名
- 新建会话时支持指定相对工作目录，默认根目录为 `~/code`
- 可配置 hub 地址
- 图片 artifact 预览
- 调试命令探针，可通过 `adb am start` 自动触发一次命令发送
- Android 端命令发送的 HTTP 回退通道，提升私网联调稳定性
- 可选的 Tailscale Serve 接入模式，用于绕过部分设备对 `100.x.x.x:port` 的直连异常
- 项目级 Android 模拟器自测 skill，可用于标准化 APK 构建、安装、探针验证与交付刷新

当前首页的 `New` 入口会向 hub 请求：

1. 查询本机可用 agent profile
2. 根据用户输入的相对 workdir，在默认工作区根目录下创建或复用目录
3. 创建一个新的 tmux session，并将该目录作为工作目录
4. 拉起对应 bridge
5. 让新会话自动出现在联系人列表中

当前 `opencode` profile 的实现方式为直接调用本机安装的新版 OpenCode CLI：

1. Hub 只在检测到真实可用的 OpenCode 配置时才返回 `opencode` profile
2. tmux bridge 在 `send_text` 时直接执行本机 `opencode run ... --format json --dir .`
3. 实际使用的 provider、model 与认证由用户自己的 OpenCode 配置决定
4. 若当前机器没有配置真实 OpenCode agent，则 `opencode` 不会出现在新建会话列表中

Hub 默认使用 `~/code` 作为工作区根目录。若要修改，可在启动 hub 前设置：

```bash
export SESSION_WORKDIR_ROOT_RELATIVE=code
```

该变量应保持为相对于用户 home 的路径片段，例如：

- `code`
- `workspace`
- `projects/agent-lab`

Android 构建链仍需要 Android SDK 才能完整编译验证。相关说明见：

- `docs/guides/android-debug.md`
- `docs/guides/private-network.md`

项目内置的 Android 模拟器自测 skill 位于：

- `.agents/skills/android-emulator-selftest/SKILL.md`

## 文档索引

- 需求建模：`docs/requirements/private-agent-im-mvp.md`
- 方案选择：`docs/design/architecture.md`
- 实施计划：`docs/design/implementation-plan.md`
- 协议定义：`docs/interfaces/protocol.md`
- 本地开发：`docs/guides/local-development.md`
- Android 调试：`docs/guides/android-debug.md`
- 私网与 Tailscale：`docs/guides/private-network.md`
- Tailscale Serve 回退接入：`docs/requirements/tailscale-serve-access-mode.md`
- tmux / command 接入：`docs/guides/bridge-integration.md`
- OpenCode 真实性修正：`docs/requirements/opencode-real-provider.md`
- OpenCode 新版 CLI 适配：`docs/requirements/opencode-cli-v2-adapter.md`
- 会话运行态信息栏：`docs/requirements/session-runtime-metrics-bar.md`
- 会话底部上下文状态栏：`docs/requirements/conversation-footer-context-bar.md`

## 当前验证状态

当前仓库优先保证 Node.js 侧和 tmux bridge 的最小闭环可以跑通。

- 已验证：hub、协议、shell command bridge、tmux bridge、基础测试、demo 脚本
- 未完整验证：Android 原生客户端编译与真机连接

若要完成 Android 侧自测，需要补充：

- Android SDK
- Android Studio 或等价命令行构建环境
- 一台可访问私网 hub 的 Android 设备或模拟器
