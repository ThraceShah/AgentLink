# Personal Private Agent IM

一个运行在局域网、Tailscale tailnet 或其他私网中的个人私有 Agent IM 原型系统。

它不是通用 IM，也不是远程桌面，而是一个面向“你”和“多个动态变化的 code agents”之间的轻量消息与控制系统。

## 当前 MVP 范围

- 轻量 hub：负责 agent 注册、在线状态、会话时间线和命令转发
- Node.js agent bridge：负责把示例 agent 或 shell command task 接入 hub
- 示例 agent：默认作为 OpenAI bridge 运行，用于演示 agent 上线、真实对话回执、产物回传、下线
- Android 原生客户端骨架：Jetpack Compose + OkHttp WebSocket
- tmux bridge：把 tmux session / pane 接入为可控制 agent
- tmux bridge 现已支持 `codex` profile，可直接作为本机 Codex bridge 使用
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
│   ├── command-agent/
│   └── demo-agent/
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

### 3. 启动示例 agent

```bash
npm run dev:demo-agent
```

若要让示例 agent 返回真实模型结果，还需要在启动前设置：

```bash
export OPENAI_API_KEY=your_key
export OPENAI_MODEL=gpt-4.1-mini
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
- 会话时间线
- Inbox 概览摘要与更清晰的状态层级
- 快捷命令
- 文本指令发送
- 可配置 hub 地址
- 图片 artifact 预览
- 调试命令探针，可通过 `adb am start` 自动触发一次命令发送
- Android 端命令发送的 HTTP 回退通道，提升私网联调稳定性
- 可选的 Tailscale Serve 接入模式，用于绕过部分设备对 `100.x.x.x:port` 的直连异常

Android 构建链仍需要 Android SDK 才能完整编译验证。相关说明见：

- `docs/guides/android-debug.md`
- `docs/guides/private-network.md`

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

## 当前验证状态

当前仓库优先保证 Node.js 侧和 tmux bridge 的最小闭环可以跑通。

- 已验证：hub、协议、示例 agent、shell command bridge、tmux bridge、基础测试、demo 脚本
- 未完整验证：Android 原生客户端编译与真机连接

说明：

- 若未配置 `OPENAI_API_KEY`，示例 agent 会明确提示缺失条件，不再伪造回声回复

若要完成 Android 侧自测，需要补充：

- Android SDK
- Android Studio 或等价命令行构建环境
- 一台可访问私网 hub 的 Android 设备或模拟器
