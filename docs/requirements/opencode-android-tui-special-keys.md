# OpenCode Android TUI 特殊按键交互需求

## 背景

当前项目中的 `opencode` 已切换到真实交互式 provider session。

在普通问答场景下，Android 客户端只需要通过 `send_text` 发送文本即可完成对话。但在模型选择器、确认框、命令面板等 TUI 界面中，OpenCode 需要接收的不是“文本加回车”，而是方向键、`Enter`、`Esc`、`Tab`、`Backspace`、`Ctrl+C`、`Ctrl+P` 等特殊按键或组合键。

此前项目采用的临时方案是提示用户通过 `tmux attach -t <session>` 自行接管 tmux 会话。该方案可以兜底，但会打断 Android 客户端的连续使用体验，也不满足“在手机端直接完成交互式操作”的目标。

## 目标

在不把 Android 客户端做成完整终端模拟器的前提下，为 `opencode` 提供可用的 TUI 操作能力，使用户可以在 Android 会话页直接完成常见的交互式菜单选择和组合键操作。

## 非目标

- 本次不实现完整 ANSI 终端渲染。
- 本次不实现 tmux pane 的逐字符远程画面同步。
- 本次不要求 Android 客户端复刻完整桌面键盘。
- 本次先以 `opencode` 为首个适配对象，不要求同时完成 `qwen`、`codex`、`copilot` 的 UI 接入。

## 需求

### 1. 协议层新增 `send_key`

- Hub 协议需要新增 `send_key` 命令类型。
- `send_key` 用于表达“发送一次特殊按键或组合键”，不应复用 `send_text`。
- `send_key` 请求体需要支持：
  - 基础按键名，例如 `up`、`down`、`enter`、`esc`、`tab`、`backspace`
  - 单字符字面键，例如 `c`、`j`、`y`
  - 修饰键列表，例如 `ctrl`、`alt`、`shift`

示例：

```json
{
  "agentId": "android-opencode",
  "command": {
    "id": "cmd_send_key_001",
    "type": "send_key",
    "args": {
      "key": "c",
      "modifiers": ["ctrl"]
    }
  }
}
```

### 2. tmux bridge 的按键映射

- `tmux-agent` 在收到 `send_key` 后，需要把按键映射为 `tmux send-keys`。
- 对单字符普通按键：
  - 无修饰键时应以字面形式发送，不附带回车。
- 对特殊按键：
  - 应映射到 tmux 认可的键名，例如 `Up`、`Down`、`Enter`、`Escape`、`Tab`、`BSpace`
- 对组合键：
  - 应支持至少 `ctrl + <key>`
  - 允许在 tmux 可表达的范围内继续支持 `alt`、`shift`
- 无法识别的键名必须拒绝执行，并返回明确错误，而不是静默忽略。

### 3. OpenCode 的 TUI 状态回传

- 当 `opencode` 会话进入 TUI 选择器、菜单或类似等待按键输入的状态时：
  - bridge 需要继续发出 `need_user_input`
  - `need_user_input.body` 应保留当前菜单的文本摘要，而不是 attach 指令
  - `metadata` 中应明确标记当前是 `inputMode=tui`
  - `metadata` 中应携带 `supportsSpecialKeys=true`
- Android 客户端应据此显示专用按键控制条。

### 4. Android 专用按键控制条

- 当当前会话最近一次等待输入事件标记为 `inputMode=tui` 时，Android 会话输入区上方应展示轻量按键控制条。
- 控制条至少支持：
  - `↑`
  - `↓`
  - `←`
  - `→`
  - `Enter`
  - `Esc`
  - `Tab`
  - `Backspace`
  - `Ctrl`
- 普通文本输入框仍应保留，避免影响自然语言对话。

### 5. 动态组合键状态机

- `Ctrl` 不能像固定按钮 `Ctrl+C` 那样立即发送。
- 用户点击 `Ctrl` 后，客户端应进入“待组合键”状态。
- 在待组合键状态下：
  - 下一次点击普通键或特殊键时，客户端再一次性发送组合键
  - 例如：先点 `Ctrl`，再点 `C`，实际发送 `Ctrl+C`
  - 例如：先点 `Ctrl`，再点 `P`，实际发送 `Ctrl+P`
- 组合键发送完成后，待组合键状态应自动清空。
- 用户再次点击已激活的修饰键时，应允许取消待组合键状态。

### 6. 单字符按键输入

- 除预置方向键和控制键外，Android 端还需要允许发送单字符按键。
- 该能力用于覆盖 `j/k`、`y/n`、`a-z` 等 TUI 快捷键。
- 实现方式可以是：
  - 预置少量建议键
  - 或弹出一个“输入单个按键”的轻量对话框
- 输入的字符只作为按键发送，不应自动附带回车。

### 7. 时间线与通知约束

- `send_key` 不应在时间线中额外生成可见聊天气泡。
- TUI 状态本身只应通过 `need_user_input` 的菜单摘要进行展示。
- 特殊按键操作不应额外触发新的 Android 系统通知。

## 验收标准

- 在 Android 中进入 `opencode` 的模型选择器后，时间线可看到菜单摘要。
- Android 输入区出现 TUI 专用按键控制条。
- 用户可通过 `↑/↓/Enter` 在 Android 中完成模型选择。
- 用户点击 `Ctrl` 后不会立即发送任何命令。
- 用户随后点击 `C` 时，会真正向 tmux 发送 `Ctrl+C`。
- 用户随后点击 `P` 时，会真正向 tmux 发送 `Ctrl+P`。
- 普通文本输入仍可继续用于自然语言消息，不受 TUI 控制条影响。
- Android 模拟器自测需要覆盖至少一次：
  - `opencode` 普通文本请求
  - `opencode` 的 `/model` 或同类 TUI 菜单触发
  - TUI 特殊按键发送链路验证
