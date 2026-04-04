## 背景

当前项目已接入 `opencode` profile，但本机安装的是归档版 OpenCode CLI，实际运行时存在两类问题：

- bridge 仍沿用错误的新版配置假设，无法正确构造旧版 OpenCode 所需的配置；
- 旧版 OpenCode 依赖外部 provider 凭据或本地 `LOCAL_ENDPOINT`，在当前机器上没有稳定可复用的现成配置。

与此同时，项目已经具备可工作的 `qwen` CLI bridge。为了让 `opencode` 真正可用，需要为它补一层本机 OpenAI-compatible 代理，使 `opencode` 可以通过 `LOCAL_ENDPOINT` 访问本地可用的 CLI agent。

## 目标

1. 新增一个轻量本地代理服务，对 OpenCode 暴露最小 OpenAI-compatible 接口。
2. 该代理默认复用当前机器可用的 `qwen` CLI，避免依赖额外公网 API key。
3. `opencode` bridge 应自动为每个会话准备正确的旧版 OpenCode 配置。
4. `opencode` 会话应能在 IM 中完成最小闭环：
   - 创建会话
   - 发送消息
   - 收到 agent 回复
5. 文档应明确说明当前 `opencode` 的运行机制与约束。

## 非目标

- 本次不实现 OpenCode 官方 TUI 的完整交互式 tool loop。
- 本次不要求兼容所有 OpenAI-compatible 字段，只覆盖当前 OpenCode bridge 实际用到的最小接口。
- 本次不引入重量级本地推理运行时，例如 Ollama、vLLM、LM Studio。
- 本次不额外要求 Android UI 改动。

## 方案约束

- 代理服务必须足够轻量，优先使用现有 Node.js 技术栈实现。
- 默认后端优先使用 `qwen` CLI。
- 配置文件、临时目录和运行输出不能要求用户手工干预。
- `opencode` bridge 生成的配置应避免污染用户已有的全局 OpenCode 配置。

## 功能要求

### 1. 本地代理

- 新增 `apps/opencode-proxy/`。
- 提供以下接口：
  - `GET /healthz`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- `POST /v1/chat/completions` 至少支持：
  - `model`
  - `messages`
  - `stream`

### 2. 后端执行

- 默认后端为 `qwen`。
- 将 OpenAI message 数组整理为单次 CLI prompt。
- 从 `qwen` 的 `stream-json` 输出中提取最终文本结果。
- 当上游要求 `stream=true` 时，代理应返回最小可用的 SSE 响应。

### 3. opencode bridge

- `opencode` profile 不再依赖用户手工配置全局 `~/.opencode.json`。
- bridge 在每次执行时应为本次任务生成隔离的临时 HOME 与 `.opencode.json`。
- 生成的配置应使用 `local.*` 模型并指向本会话对应的本地代理端口。

### 4. 会话级代理管理

- 每个 `opencode` 会话使用独立代理实例。
- 代理实例应绑定该会话的工作目录。
- 删除会话时应同时停止对应代理进程。

## 验收标准

满足以下条件视为完成：

1. 通过 Hub 创建 `opencode` 会话后，bridge 能成功上线。
2. 向该会话发送一条文本消息后，能在时间线中收到真实回复。
3. 删除会话后，对应 tmux session 和本地代理进程均被清理。
4. `npm test` 和 `npm run build` 通过。
