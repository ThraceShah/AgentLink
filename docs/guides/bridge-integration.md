# Bridge 集成说明

## 当前 Bridge 类型

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
- 项目内不再内置任何直连模型 API 的 demo bridge；真实 AI 对话统一通过本机真实可用的 CLI profile 接入

## Codex bridge 模式

当前 `tmux-agent` 已支持：

- `TMUX_BRIDGE_PROFILE=codex`

该模式会：

- 默认把联系人显示名设置为 tmux session 名
- 默认把 agent 类型标识为 `codex`
- 默认使用 `TMUX_CODEX_MODE=interactive`
- 在默认交互式模式下，tmux session 仅保留工作目录与生命周期绑定，真实对话由 bridge 本地启动的 `codex app-server` 长会话子进程处理
- `send_text` 会复用同一个 Codex thread，普通消息通过 `turn/start` 发送，`stop` 会改走 `turn/interrupt`
- `/model` 会通过 `model/list` 拉取真实模型列表，并映射为 Android 可点击菜单
- 识别 app-server 中的 approval / input request，并继续复用 Android 的通用 dialog / menu 链路

模式说明：

- `TMUX_CODEX_MODE=exec`
  - 显式 fallback
  - 适合保留旧的非交互单轮执行路径
  - 仍会本地 `spawn()` `codex exec`，避免 detached tmux shell 中的 stdin / JSON 卡住
- `TMUX_CODEX_MODE=interactive`
  - 当前默认值
  - 基于 `codex app-server`，而不是解析 detached tmux 的 TUI 屏幕
  - 已完成真实端到端验证，包括 Android `/model` 菜单点击与模型切换后继续对话

推荐启动方式：

```bash
npm run dev:codex-bridge
```

或显式指定 tmux session：

```bash
TMUX_BRIDGE_PROFILE=codex TMUX_SESSION=my-codex npm run dev:tmux-agent
```

若要切回旧的 `exec` 降级模式：

```bash
TMUX_BRIDGE_PROFILE=codex TMUX_CODEX_MODE=exec npm run dev:tmux-agent
```

## 通过 Hub 创建新会话

当前 hub 已提供轻量会话管理接口：

- `GET /api/agent-profiles`
- `GET /api/session-config`
- `POST /api/sessions`
- `POST /api/admin/prune-offline`

其中：

- `GET /api/session-config` 用于返回当前 Hub 的工作区根目录提示和主机用户名，供 Android 新建会话弹窗与首页头部展示。
- `POST /api/sessions` 现需同时提交 `sessionName`、`profileId` 和 `workdir`。
- `workdir` 必须是相对于工作区根目录的路径，例如 `test` 或 `tests/first_test`。
- Hub 默认会将工作区根目录解析为 `~/code`，也可以通过 `SESSION_WORKDIR_ROOT_RELATIVE` 修改为其他相对路径。
- 当前 Hub 会自动检测本机真实可用的 profile，例如 `qwen`、`codex`、`copilot`，以及在真实配置完成后的 `opencode`。

Android 首页的“新增会话”按钮实际会调用这些接口。

典型流程：

1. Hub 返回当前机器真实可用的 agent profile，例如 `qwen`、`codex`、`copilot`，以及在真实配置完成后的 `opencode`
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
- `TMUX_BRIDGE_PROFILE`：`generic`、`opencode`、`codex`、`copilot` 或 `qwen`
- `TMUX_CODEX_MODE`：`exec` 或 `interactive`
- `IRIS_TMUX_PANE`：可选，显式绑定某个 pane
- `TMUX_POLL_MS`：轮询间隔
- `TMUX_APPROVE_TEXT`：`approve` 命令默认发送内容

## 当前 provider 支持

### opencode

- 默认使用真实 OpenCode 交互式 CLI / TUI 会话，而不是 `opencode run`
- 直接调用本机真实 `opencode` CLI
- 使用用户已有的 OpenCode 全局配置与 provider 认证
- 只有在真实 OpenCode 配置可用时，Hub 才会返回该 profile
- Android 发出的文本会直接写入同一个长期驻留的 OpenCode session
- `/model` 等原生 slash command 会直接交给 OpenCode 自身处理，而不再被当成一次性 prompt 文本
- bridge 会在交互会话完成当前轮次后，再向 Android 落最终 `text_output`，随后切回 `need_user_input`
- 对于 OpenCode 在交互过程中弹出的 TUI 选择器，bridge 会把菜单摘要作为 `need_user_input` 回传给 Android，并标记当前输入模式为 `tui`
- Android 会话输入区会显示专用特殊按键控制条，可直接发送方向键、`Enter`、`Esc`、`Tab`、`Backspace` 与动态组合键
- 组合键采用“先激活修饰键，再点下一键”的状态机，例如先点 `Ctrl`，再点 `C`，才会真正发送 `Ctrl+C`

### codex

- 默认使用 `codex app-server` 长会话协议，而不是 `codex exec --json`
- bridge 会把 Codex 的 thread id、当前模型与工作目录持久化到 `temp_docs/codex_bridge/<session>/app-server-state.json`，bridge 重启后会优先 `thread/resume`
- detached tmux 下 `codex --no-alt-screen` 之所以看起来“空白”，根因是 Codex 会先等待终端能力握手；当前默认实现不再依赖这条 TUI 截屏路径
- Android 已验证以下闭环：普通消息、完成通知、`/model` 真实菜单弹出、菜单 `Cancel`、模型切换后继续多轮对话
- 若显式设置 `TMUX_CODEX_MODE=exec`，bridge 仍会保留本地 `spawn()` `codex exec` fallback，并继续在 `temp_docs/codex_bridge/<session>/` 写 prompt、reply、stderr 与 status 文件

### copilot

- 默认使用 GitHub Copilot CLI 的真实交互式 session
- `/model`、`/session` 等菜单会被 bridge 解析成通用 `tui_menu` dialog 回传给 Android
- `/context`、`/compact` 这类纯文本结果会在 Copilot 回到输入态后作为最终消息落到 Android
- Android 侧默认复用与 OpenCode 相同的弹窗与特殊按键链路

### qwen

- 默认使用 Qwen Code CLI 的真实交互式 session
- bridge 会按 Qwen 原生键位处理发送语义：普通消息直接提交，slash command 会先接受命令 suggestion，再进入原生菜单或命令结果
- `/model` 已适配为 Android 可点击的模型选择 dialog
- `/status` 等纯文本 framed dialog 也会映射为 Android 通用弹窗，并支持 `Cancel -> Esc`
- Qwen 回复完成后，bridge 会在原生 prompt 恢复后再向 Android 落最终消息

## Streaming Bridge 现状

当前 bridge 已支持两类主要路径：

### 1. 乐观用户消息

- Android 在发送消息时会立刻把用户消息插入本地时间线
- 服务端确认后会按相同事件 ID 去重，不会重复显示

### 2. Provider 输出桥接

- `opencode`：真实交互式 session，已支持菜单、纯文本 modal、输入型 dialog 与完成通知
- `copilot`：真实交互式 session，已支持 `/model`、`/session` 菜单和 `/context`、`/compact` 等纯文本结果回传
- `qwen`：真实交互式 session，已支持普通对话完成态、`/model` 菜单与 `/status` 纯文本 dialog 回传
- `codex`：默认走 app-server 交互式长会话；`exec` 仅作为显式 fallback 保留

这意味着当前已经具备“先显示用户消息，再在回复完成后稳定落一条最终 agent 消息”的 IM 体验；bridge 仍会保留对流式输出的内部解析能力，用于提取最终文本与元数据。

注意：

- 不使用系统自带的 `TMUX_PANE` 环境变量作为默认绑定来源，避免错误抓取当前工作 pane
- tmux bridge 只能稳定拿到 pane 输出和部分 pane 状态，不能像原生 agent 一样天然拿到完整任务语义

## 演示

```bash
npm run demo:tmux
```
