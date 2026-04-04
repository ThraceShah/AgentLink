# 会话运行态信息栏需求

## 背景

当前 Android 会话页已经能显示：

- 会话名称
- agent 类型
- 连接状态
- 会话状态

但对于真实 AI agent 使用场景，仍缺少两类高频运行信息：

1. 当前实际使用的模型
2. 当前上下文占用情况与上下文窗口大小

这会导致用户在使用 `opencode`、`qwen`、`codex`、`copilot` 等会话时，无法快速判断：

- 当前回复到底由哪个底层模型生成
- 当前上下文是否已接近上限
- 为什么某些会话开始变慢，或者需要重开会话

## 目标

为 Android 会话页增加一个紧凑的会话运行态信息栏，用于展示当前会话最近一次有效推理的模型与上下文指标。

## 非目标

- 本次不改造成完整的调试面板。
- 本次不展示 provider 全量计费信息。
- 本次不保证所有 provider 都能拿到上下文窗口上限；拿不到时允许明确展示为不可用。
- 本次不为了显示窗口大小而接入额外公网依赖或外部模型规格数据库。

## 功能要求

### 1. Android 会话页展示

- 在会话页增加一个固定可见的运行态信息栏。
- 该信息栏至少展示：
  - 当前模型
  - 当前上下文使用量
- 若当前 provider 能提供上下文窗口上限，则同时展示：
  - 已用 / 上限
- 若拿不到上限，则应明确显示为：
  - `window unavailable`
  - 或等价的简短说明

### 2. 指标来源

- Android 不应自行猜测模型和 usage。
- 指标应来自会话时间线事件中的结构化 metadata。
- 优先使用最近一次真实推理结果中的 metadata 作为当前会话状态。

### 3. Bridge metadata 丰富化

- `tmux-agent` 在 `opencode`、`qwen`、`codex`、`copilot` profile 下，应尽量从 provider 输出中提取：
  - `model`
  - `inputTokens`
  - `outputTokens`
  - `totalTokens`
  - `contextUsedTokens`
  - `contextWindowTokens`（若能拿到）
- 若某 provider 只能拿到部分字段，也应尽量回传可得字段，而不是全部缺省。

### 4. OpenCode 特殊要求

- `opencode` 会话顶部或底部信息栏中，应显示当前真实选择的基模，而不是仅显示 `opencode`。
- 若 OpenCode JSON 事件本身不直接提供模型字段，可允许 bridge 从本次执行输出中的日志或其他本地可用元数据中提取。

## 验收标准

- Android 会话页中能稳定看到当前模型信息。
- `opencode` 会话中显示的模型不再只是 `opencode`，而是实际基模。
- 至少一类 provider 能显示上下文已用量。
- 若窗口上限未知，界面会明确显示未知状态，而不是展示错误或误导值。
