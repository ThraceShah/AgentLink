# Bridge 集成说明

## 当前 Bridge 类型

### `demo-agent`

用于演示协议闭环与 UI 形态。

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
- 周期性 `capture-pane`，把最近输出摘要发到时间线
- 检测常见 approval / input 提示并转成 `need_approval` 或 `need_user_input`
- `send_text` 映射为 `tmux send-keys`
- `approve` 默认发送 `y`
- `stop` 对受管 session 执行 `kill-session`，否则发送 `Ctrl-C`
- `retry` 对受管 session 重新创建会话

## 关键环境变量

- `TMUX_SESSION`：目标 session 名
- `TMUX_COMMAND`：若指定，则由 bridge 创建并管理该 session
- `IRIS_TMUX_PANE`：可选，显式绑定某个 pane
- `TMUX_POLL_MS`：轮询间隔

注意：

- 不使用系统自带的 `TMUX_PANE` 环境变量作为默认绑定来源，避免错误抓取当前工作 pane
- tmux bridge 只能稳定拿到 pane 输出和部分 pane 状态，不能像原生 agent 一样天然拿到完整任务语义

## 演示

```bash
npm run demo:tmux
```
