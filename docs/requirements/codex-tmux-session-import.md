# Codex tmux 会话导入需求

## 背景

当前 Codex 移动端默认通过 `codex app-server` 驱动长期 thread，不再解析 tmux 中的 Codex TUI 屏幕。用户仍可能已经在本机 tmux 中启动了 Codex TUI，并希望将这些既有工作迁移到 AgentLink 中查看和继续。

## 目标

- Hub 能扫描本机 tmux pane，识别前台或进程树中运行 Codex TUI 的 pane。
- Hub 能基于 Codex 本地记录恢复该 thread 的用户消息和最终 assistant 回复，作为 AgentLink timeline 导入。
- 导入后继续工作必须走 `codex app-server`，不再通过 `tmux send-keys` 驱动原 TUI。
- 用户导入时可以选择：
  - `fork`：保留原 tmux TUI，AgentLink 从原 Codex thread fork 出新 thread 后继续。
  - `takeover`：退出原 tmux session，AgentLink 直接 resume 原 Codex thread 后继续。

## 非目标

- 不从 Codex TUI 屏幕或 tmux scrollback 重建完整对话。
- 不支持 AgentLink 和原 Codex TUI 同时继续操作同一个 thread。
- 不保证恢复 Codex 内部过程事件、工具调用细节和 reasoning 内容；第一版只恢复可展示的用户消息和最终回复。

## 行为要求

- `GET /api/codex/tmux-candidates` 返回可导入候选，包括 tmux session、pane、工作目录、Codex thread、标题、预览和更新时间。
- `POST /api/codex/import-tmux` 根据候选创建 AgentLink codex session，并导入历史 timeline。
- `fork` 模式应在 bridge 启动时调用 Codex app-server `thread/fork`，后续消息进入 fork 后的新 thread。
- `takeover` 模式应在启动 AgentLink bridge 前停止原 tmux session，避免双端并发操作。
- 如果本机缺少 `tmux`、`sqlite3`、Codex state DB 或 rollout 文件，接口应返回明确错误或空候选，而不是影响普通 Hub 功能。

## 验证要求

- 单元测试覆盖 Codex rollout JSONL 到 Hub timeline 的转换。
- Hub 集成测试覆盖候选 API 和导入 API 的基本返回。
- 手动验证可通过 Web UI 的导入入口完成候选刷新、fork/takeover 选择和导入后继续对话。
