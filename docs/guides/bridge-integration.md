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

- 默认把联系人显示名设置为 tmux session 名
- 默认把 agent 类型标识为 `codex`
- 默认使用 `TMUX_CODEX_MODE=exec`
- 在 `exec` 模式下，tmux session 作为 shell 容器，`send_text` 会触发 `codex exec`
- 通过 `--output-last-message` 稳定提取最终回复，不依赖向 TUI 注入按键后的屏幕解析
- 对 pane 输出做增量提取，而不是每次发送整屏摘要
- 尽量过滤输入回显和常见过程噪音
- 识别常见 approval / input 提示

模式说明：

- `TMUX_CODEX_MODE=exec`
  - 推荐默认值
  - 更稳定
  - 已完成真实端到端验证
- `TMUX_CODEX_MODE=interactive`
  - 保留为兼容回退
  - 依赖交互式 TUI 输入注入，稳定性较差

推荐启动方式：

```bash
npm run dev:codex-bridge
```

或显式指定 tmux session：

```bash
TMUX_BRIDGE_PROFILE=codex TMUX_SESSION=my-codex npm run dev:tmux-agent
```

若要切回交互式 TUI 模式：

```bash
TMUX_BRIDGE_PROFILE=codex TMUX_CODEX_MODE=interactive TMUX_COMMAND='codex --no-alt-screen' npm run dev:tmux-agent
```

## 通过 Hub 创建新会话

当前 hub 已提供轻量会话管理接口：

- `GET /api/agent-profiles`
- `GET /api/session-config`
- `POST /api/sessions`
- `POST /api/admin/prune-offline`

其中：

- `GET /api/session-config` 用于返回当前 Hub 的工作区根目录提示，供 Android 新建会话弹窗展示。
- `POST /api/sessions` 现需同时提交 `sessionName`、`profileId` 和 `workdir`。
- `workdir` 必须是相对于工作区根目录的路径，例如 `test` 或 `tests/first_test`。
- Hub 默认会将工作区根目录解析为 `~/code`，也可以通过 `SESSION_WORKDIR_ROOT_RELATIVE` 修改为其他相对路径。

Android 首页的“新增会话”按钮实际会调用这些接口。

典型流程：

1. Hub 返回当前机器可用的 agent profile，例如 `codex`
2. 用户输入一个会话名，例如 `codex-fix-login`
3. Hub 创建同名 tmux session
4. Hub 拉起对应 bridge
5. 新会话自动注册到联系人列表中

离线历史清理：

- 当 bridge 断开后，Hub 会先把联系人标记为 `offline`
- 调用 `POST /api/admin/prune-offline` 后，会移除这些离线历史会话及其时间线
- Android 客户端在重新 bootstrap 时也会主动触发一次该清理，避免历史离线联系人残留在首页

## 关键环境变量

- `TMUX_SESSION`：目标 session 名
- `TMUX_COMMAND`：若指定，则由 bridge 创建并管理该 session
- `TMUX_BRIDGE_PROFILE`：`generic` 或 `codex`
- `TMUX_CODEX_MODE`：`exec` 或 `interactive`
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
