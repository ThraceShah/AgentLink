# 会话生命周期与多 Provider 扩展需求

## 背景

当前 Android 客户端已经具备基本的 agent 会话收发能力，但在日常使用中仍有几个明显问题：

- 缺少删除会话能力，旧会话只能残留在列表中。
- 发送消息后到收到回复的体感延迟偏大。
- 会话时间线中存在 `Codex is working on your request.`、`Codex finished the request.` 这类系统提示，影响 IM 感。
- 当前只有 `codex` profile，可选 agent 不足，用户希望接入 `qwen` 和 GitHub Copilot。

## 目标

本次需要完成以下目标：

1. 支持删除会话。
2. 删除会话时，应同步清理 hub 中的联系人与时间线，并停止对应 tmux 会话和 bridge。
3. 精简会话时间线展示，去掉不必要的系统提示消息。
4. 优化 bridge 侧反馈时延，减少消息发送后到最终显示之间的额外等待。
5. 在现有 `codex` 之外，新增 GitHub Copilot provider。
6. 在条件允许时新增 `qwen` provider；若缺少运行条件，应明确记录阻塞点。

## 非目标

- 本次不做群组、标签页、多设备同步。
- 本次不引入消息流式 token 级展示。
- 本次不实现复杂 provider 配置面板。
- 本次不为每个 provider 设计独立 UI。

## 功能要求

### 1. 删除会话

- 用户应能从 Android 客户端删除当前会话。
- 删除动作应包含确认步骤，避免误删。
- 删除后应完成以下行为：
  - 停止对应 tmux session
  - 停止对应 bridge 进程
  - 从 hub store 中移除 agent 和历史事件
  - Android 列表即时移除该会话

### 2. 消息流精简

- 会话页不再展示纯系统过程消息，包括但不限于：
  - `task_running`
  - `task_completed`
- `task_failed`
- `need_approval`
- `need_user_input`
- `text_output`
- `artifact_generated`
- `image_available`

这类消息仍应保留。

### 3. 时延优化

- 需要减少 bridge 轮询带来的额外等待。
- 优先优化 bridge 侧状态文件检查与 pane 捕获频率。
- 若 provider 本身必须“任务完成后才产出最终文本”，应在文档中说明该限制。

### 4. Provider 扩展

- Hub profile 列表应自动检测并暴露本机可用 provider。
- 新建会话时，Android 可直接选择：
  - `codex`
  - `copilot`
  - `qwen`（若本机已安装且满足运行条件）

### 5. Copilot 接入

- 使用当前机器已安装的 GitHub Copilot CLI。
- 至少支持：
  - 新建会话
  - `send_text`
  - `status`
  - `retry`
  - `stop`
- 若 CLI 自身已登录可用，应完成端到端验证。

### 6. Qwen 接入

- 优先采用官方 CLI。
- 若本机缺少 CLI，应先安装。
- 若安装后仍需要额外登录、API Key 或厂商侧开通条件，应明确记录。
- 若无法在当前环境完成端到端验证，应说明阻塞项，但仍应把可落地的检测、profile 暴露和 bridge 结构先做好。

## 验收标准

- Android 客户端可删除指定会话，删除后联系人消失。
- 会话页不再出现 `Codex is working...` 和 `Codex finished...` 这类系统提示。
- `codex` 会话的回复体感延迟较当前版本缩短。
- `copilot` profile 可出现在新建会话弹窗中，并能实际回复。
- `qwen` 若已具备运行条件，则可出现在新建会话弹窗中并能实际回复；若不具备运行条件，阻塞原因必须被明确记录。
