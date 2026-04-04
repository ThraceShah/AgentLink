# Exec Profile 最终消息投递与通知时机需求

## 背景

当前 `qwen`、`opencode`、`codex exec`、`copilot` 这类非交互 prompt-mode 会话已经接入统一的 exec bridge，但 Android 端仍有两个残留体验问题：

- agent 回复尚未真正结束时，Android 时间线就可能先出现一条 `text_output`
- Android 系统通知也会在这条尚未完成的回复出现时立即触发

这会导致用户看到的会话语义和真实执行状态不一致：

- 用户以为 agent 已回复完成，但实际上 provider 仍在运行
- `qwen` 与 `opencode` 的完成时机不一致，导致通知表现不统一
- prompt-mode 会话完成后理论上应回到“等待下一条用户指令”，但状态上可能短暂停在 `completed`

## 目标

统一 exec profile 的最终消息交付语义，使 Android 端只在 agent 本轮回复真正完成后再收到最终消息，并在完成后回到等待下一条用户输入的状态。

## 范围

### 纳入本轮

- `tmux-agent` exec profile 的完成态事件顺序收敛
- Android 会话页对无正文 `need_user_input` 事件的显示策略调整
- Android 系统通知触发时机调整
- `qwen` 与 `opencode` 的最终消息/通知行为对齐

### 不纳入本轮

- 重新设计 interactive tmux attach 模式
- token 级流式动画
- provider 原生命令行输出格式改造

## 功能要求

### 1. Exec profile 最终消息投递

- 对于 `opencode`、`qwen`、`copilot`、`codex exec`：
  - provider 执行期间可在 bridge 内部解析 partial 内容
  - 但在任务退出前，不应把 partial `text_output` 广播给 Android
- 当 provider 以成功状态退出时：
  - bridge 应只发出一次最终 `text_output`
  - 随后发出无正文的 `need_user_input`
  - agent 状态应切换为 `waiting_input`

### 2. Android 会话显示

- 无正文的 `need_user_input` 仅表示状态切回“等待输入”
- 该事件不应单独生成新的聊天气泡
- 该事件不应覆盖最近一条真实 agent 消息预览

### 3. Android 系统通知

- 最终回复完成后，应由最终 `text_output` 触发通知
- 不应再对无正文的 `need_user_input` 额外触发第二条通知
- `qwen` 与 `opencode` 在同类完成场景下，通知触发行为应一致

## 验收标准

- `qwen` 会话中，Android 不再在回复生成途中提前出现 agent 最终消息
- `opencode` 会话中，回复完成后 Android 能稳定收到最终消息通知
- 同一次成功回复只产生一次最终消息通知
- provider 完成后会话状态回到 `waiting_input`
