# 多 Provider 交互式会话模式需求

## 背景

当前项目中的 `qwen`、`codex`、`copilot`、`opencode` 主要通过一次性 exec / prompt-mode 执行链路与 Android 客户端交互。该模式虽然能稳定回传最终消息，但存在以下不可接受的问题：

- Android 会话虽然存在，但 provider 侧并非真正的长期交互式会话。
- 多轮消息之间默认不具备稳定、可依赖的原生 session 连续性。
- `/model`、`/permission`、`/compact` 等依赖 CLI 交互层的 slash command 在非交互模式下不可用，或只能被错误地当作普通文本 prompt 处理。
- provider 的权限控制、会话压缩、模型切换、会话恢复等交互式能力无法被原生复用。
- 即使 provider 提供 `--continue`、`--resume`、`--session-id` 等续会话能力，非交互单轮执行模式仍不等价于真正的交互式 session。

对于当前产品目标，“能否像真实 agent CLI 一样可用”比“改造成本”更重要，因此需要从根本上切换到长期交互式 provider session 模式。

## 目标

本次需要实现以下目标：

1. `qwen`、`codex`、`copilot`、`opencode` 四类 provider 默认以长期交互式 session 运行，而不是一次性 exec。
2. Android 会话与 provider 原生 session 形成稳定映射，消息在同一会话内持续复用原生上下文。
3. provider 原生支持的 slash command 应在 Android 会话中尽可能按原义生效，而不是被桥接层误当作普通文本。
4. 保留现有 IM 形态下的时间线、通知和状态能力，但其底层数据源改为交互式 session。
5. 对不同 provider 的差异进行显式建模，避免以“假装统一”的方式掩盖真实能力边界。

## 非目标

- 本次不要求四个 provider 的所有交互命令完全统一。
- 本次不要求 Android 侧实现 provider 全量命令面板。
- 本次不要求先做 Web 或桌面端 UI 适配。
- 本次不要求删除所有 exec 模式代码；但 exec 只能作为显式降级路径，不能继续作为默认交互路径。
- 本次不为 provider 不支持的命令做“伪实现”来制造表面兼容。

## 核心原则

### 1. 原生交互优先

- 对于已支持交互式 TTY 的 provider，bridge 应优先接入其原生交互模式。
- Android 发出的普通文本输入应写入 provider 当前交互 session，而不是重新启动一次性命令。
- Android 发出的 slash command 应优先交给 provider 自身的交互命令解析层处理。

### 2. 会话真实映射

- 一个 Android agent 会话应稳定绑定一个 provider 原生 session。
- bridge 必须持有该 session 的运行态信息，包括但不限于：
  - tmux session / pane 标识
  - provider 类型
  - provider 原生 session 标识（若 provider 暴露）
  - 当前工作目录
  - 最近一次可识别的模型信息
- 删除会话时，应同时清理对应的 provider 交互 session 与桥接资源。

### 3. 不伪装命令能力

- 若 provider 原生支持 `/model`、`/compact`、权限切换、session 管理等命令，bridge 应尽量透传。
- 若 provider 不支持某命令，不应由 bridge 假装成功。
- 若某命令在 Android 中无法可靠表达其原生交互结果，必须明确记录限制，而不是静默降级。

## 功能要求

### 1. Provider 启动模式

- `qwen` 默认使用真正的交互式 CLI 会话。
- `codex` 默认使用真正的交互式 CLI 会话，而不是 `codex exec`。
- `copilot` 默认使用真正的交互式 CLI 会话，而不是 `copilot -p`。
- `opencode` 默认使用真正的交互式 CLI / TUI 会话，而不是 `opencode run`。
- bridge 启动后应等待 provider 进入可交互状态，再向 Hub 暴露为可用会话。

### 2. 多轮上下文连续性

- 同一 Android 会话中的连续消息必须复用同一个 provider 原生 session。
- provider 内部的上下文窗口、会话压缩、模型切换、usage 统计等行为应在该 session 内自然累积。
- bridge 不应再以“把历史消息手工重组回 prompt”的方式模拟上下文。

### 3. Slash Command 支持

- Android 会话中发送 `/model`、`/permission`、`/compact`、`/context`、`/session` 等命令时：
  - 若当前 provider 原生支持，应尽量按原义执行。
  - 若当前 provider 对应命令不存在，应返回 provider 的真实反馈或明确的“不支持”提示。
- bridge 不应把这些命令无条件当作普通自然语言消息发送给模型。
- 对于需要交互式菜单或多步选择的命令，bridge 应至少保证：
  - Android 能看到 provider 返回的提示文本
  - provider 后续等待输入时，Android 会话状态切回 `waiting_input`

### 4. 输出解析与消息投递

- bridge 需要持续解析交互式 pane / 输出流中的以下内容：
  - assistant 正文
  - approval / permission prompt
  - user input prompt
  - task running / idle 状态
  - model / usage / context metrics
- Android 仍应遵循 IM 语义：
  - 用户消息立即显示
  - agent 回复作为会话内连续消息展示
  - 无正文状态事件不单独生成聊天气泡
  - 最终通知时机应与真实回复完成时机一致

### 5. 会话控制

- `stop` 应尽量中断当前 provider 正在执行的轮次，而不直接销毁整个交互 session，除非 provider 只能以进程级中断实现。
- `retry` 应在当前 provider 的真实能力范围内定义：
  - 若 provider 原生支持重试上一轮，应优先使用原生命令。
  - 若不支持，应明确标记为受限能力。
- `approve` 应优先响应 provider 当前真实的 approval prompt，而不是仅发送固定字符串。

### 6. 兼容与降级

- 若某 provider 在当前机器上缺少稳定交互模式运行条件，则：
  - 不应默认暴露为“完整交互能力可用”
  - 必须明确记录阻塞原因
- 如需保留 exec 模式，必须满足：
  - 只能作为显式降级选项
  - 文档中明确说明其不支持原生 slash command 完整能力
  - Android 默认不优先选择该模式

## Provider 范围说明

### qwen

- 目标是接入 Qwen Code CLI 的长期交互式 session。
- `/model`、`/hooks` 等交互命令应以 Qwen 原生行为为准。
- 会话上下文应由 Qwen 原生 session 持续维护。

### codex

- 目标是接入 Codex CLI 交互模式，而不是 `codex exec`。
- `resume`、模型切换、权限控制等交互能力应尽量按 Codex 原生行为工作。

### copilot

- 目标是接入 GitHub Copilot CLI 交互模式，而不是 `copilot -p`。
- `/model`、`/compact`、`/context`、`/session` 等交互命令应尽量按 Copilot 原生行为工作。

### opencode

- 目标是接入 OpenCode 交互模式，而不是 `opencode run`。
- 会话管理、模型切换与其他交互能力应以 OpenCode 原生行为为准。

## 验收标准

- `qwen` 会话中发送 `/model` 不再出现“非交互模式不能用这个命令”。
- `copilot` 会话中发送 `/compact` 时，Android 能收到该交互命令对应的真实执行结果。
- 同一会话连续多轮对话时，provider 原生上下文持续生效，而不是每轮重新开始。
- `codex`、`qwen`、`copilot`、`opencode` 默认配置下均优先进入交互式 session，而不是一次性 exec。
- Android 端对无正文状态事件的展示与通知规则保持稳定，不因切到交互式模式而退化。
- 会话删除后，对应 tmux session、bridge 绑定和 provider 交互资源被同步清理。

## 风险与约束

- 不同 provider 的 TUI 输出结构差异较大，bridge 需要分别适配解析策略。
- 某些 provider 的交互命令可能依赖光标控制、菜单选择或 alternate screen；若当前终端行为不稳定，需要专门处理。
- `stop`、`retry`、`approve` 在不同 provider 中的真实语义可能不一致，必须按 provider 区分实现。
- 若某 provider 的交互模式无法稳定通过 tmux 捕获与驱动，需要单独记录阻塞并决定是否改走更底层的 PTY 方案。

## 后续设计要求

- 在正式实现前，需要补充交互式 bridge 设计文档，明确：
  - tmux / PTY 驱动方式
  - provider 输出解析策略
  - Android 时间线事件映射规则
  - provider 特定命令与能力矩阵
  - 失败恢复与自测方案
