# Streaming Bridge 与乐观消息显示需求

## 背景

当前 Android 客户端虽然已经可以与多个 agent 会话交互，但仍有两个核心体验问题：

- 用户发出的消息不会立刻出现在消息列表中，通常要等到 agent 有后续反馈后才显得“像是发出去了”。
- 现有 bridge 主要采用“一次性执行，结束后回传最终结果”的模式，缺少真正接近 IM 的流式回显体验。

在现有 provider 中，`qwen` 已具备明确的流式 JSON 输出能力，适合作为 streaming bridge 的第一条验证路径。`copilot` 也具备 JSON 流能力。`codex` 当前非交互 `exec --json` 主要提供最终消息事件，适合先统一到 JSON bridge 结构中，再视情况推进更强的交互式能力。

## 目标

本次需要完成以下目标：

1. 用户发出的消息应立即显示在会话时间线中。
2. 当服务端确认同一条用户消息后，不应在 UI 中产生重复消息。
3. `qwen` provider 需要先接入真正的流式消息桥接。
4. `copilot` provider 需要复用同类流式桥接能力。
5. `codex` provider 至少要接入统一的 JSON bridge 结构，即使当前仍是最终消息回传，也要与 streaming bridge 架构兼容。
6. 流式消息在 UI 中应表现为“同一条回复逐步更新”，而不是每个 chunk 都新增一条气泡。

## 非目标

- 本次不做 token 级光标动画。
- 本次不做服务端消息持久化数据库。
- 本次不切换 Android 的整体会话布局。
- 本次不强制把 `codex` 做成完整交互式 TUI 解析模式。

## 功能要求

### 1. 用户消息即时显示

- 当用户点击发送后，应立即在本地时间线中插入对应 `user_command`。
- 服务端随后返回同一条 `user_command` 时，应与本地消息去重，而不是重复出现。

### 2. 流式消息更新模型

- provider 在执行期间若产生部分文本，应持续更新同一条 `text_output` 消息。
- 同一条流式消息需要复用固定事件 ID。
- 客户端收到相同事件 ID 的更新时，应覆盖旧内容，而不是新增第二条消息。

### 3. Qwen streaming

- 使用 Qwen Code CLI 官方 `stream-json` 输出模式。
- 过滤掉 thinking / system 初始化等非最终对话内容。
- 优先展示 assistant 文本增量。

### 4. Copilot streaming

- 使用 GitHub Copilot CLI 的 JSON 输出流。
- 过滤掉 session / MCP / telemetry 等非聊天内容。
- 优先展示 assistant 文本增量。

### 5. Codex JSON bridge

- 使用 `codex exec --json`。
- 当前至少提取最终 agent message。
- 结构上应与流式 provider 共用同一套 bridge 代码路径。

## 验收标准

- 用户发送消息后，消息立即出现在 Android 会话页中。
- 相同用户消息不会因为服务端确认而出现两条。
- `qwen` 会话能在回复完成前看到逐步更新的文本。
- `copilot` 会话能在回复完成前看到逐步更新的文本。
- `codex` 会话在当前版本中至少仍可稳定回传最终消息，并复用统一 JSON bridge 结构。
