# Bridge 集成说明

## 当前 Bridge 类型

### `demo-agent`

用于演示协议闭环与 UI 形态。

当前默认作为 OpenAI bridge 使用。

关键环境变量：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_SYSTEM_PROMPT`

行为说明：

- 当配置了 `OPENAI_API_KEY` 时，`send_text` 会转发给 OpenAI Responses API
- 当未配置 `OPENAI_API_KEY` 时，agent 会在时间线中明确提示缺失条件
- `retry` 会重放上一条用户输入
- `custom=image_demo` 仍可用于生成演示图片 artifact

### `command-agent`

用于接入 shell command task。

它支持两种输出模式：

1. 普通文本输出
2. 结构化事件输出，格式为：

```text
AGENT_EVENT {"eventType":"need_approval","title":"Review patch","body":"Please approve apply_patch"}
```

## 与 tmux 的关系

当前仓库已经提供第一版 `tmux-agent`。

它支持两种接入方式：

1. 绑定已有 tmux session
2. 使用 `TMUX_COMMAND` 创建并管理一个新的 tmux session

## `tmux-agent` 的能力

- 将 session / pane 映射为一个 agent 联系人
- 周期性 `capture-pane`，提取增量输出并发到时间线
- 检测常见 approval / input 提示并转成 `need_approval` 或 `need_user_input`
- `send_text` 映射为 `tmux send-keys`
- `approve` 默认发送 `y`
- `stop` 对受管 session 执行 `kill-session`，否则发送 `Ctrl-C`
- `retry` 对受管 session 重新创建会话
- `status` 优先返回最近一次有效回复，而不是整屏 pane 摘要

## Codex bridge 模式

当前 `tmux-agent` 已支持：

- `TMUX_BRIDGE_PROFILE=codex`

该模式会：

- 默认把 agent 标识为 `codex-bridge`
- 在未显式提供 `TMUX_COMMAND` 时默认尝试启动 `codex`
- 对 pane 输出做增量提取，而不是每次发送整屏摘要
- 尽量过滤输入回显和常见过程噪音
- 识别常见 approval / input 提示

推荐启动方式：

```bash
npm run dev:codex-bridge
```

或显式指定 tmux session：

```bash
TMUX_BRIDGE_PROFILE=codex TMUX_SESSION=my-codex npm run dev:tmux-agent
```

## 关键环境变量

- `TMUX_SESSION`：目标 session 名
- `TMUX_COMMAND`：若指定，则由 bridge 创建并管理该 session
- `TMUX_BRIDGE_PROFILE`：`generic` 或 `codex`
- `IRIS_TMUX_PANE`：可选，显式绑定某个 pane
- `TMUX_POLL_MS`：轮询间隔
- `TMUX_APPROVE_TEXT`：`approve` 命令默认发送内容

注意：

- 不使用系统自带的 `TMUX_PANE` 环境变量作为默认绑定来源，避免错误抓取当前工作 pane
- tmux bridge 只能稳定拿到 pane 输出和部分 pane 状态，不能像原生 agent 一样天然拿到完整任务语义

## 演示

```bash
npm run demo:tmux
```
