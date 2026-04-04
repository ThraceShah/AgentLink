# AgentLink 品牌与许可调整需求

## 背景

当前项目和 Android 客户端仍带有早期的通用占位命名，例如 `Personal Agent IM` 和 `project_iris`。随着原型功能逐步稳定，需要统一为更明确的产品名，并补齐开源许可信息。

## 目标

- 将 Android 应用显示名称调整为 `AgentLink`。
- 将项目的对外名称统一为 `AgentLink`。
- 为仓库补充 `MIT` 许可协议文件。
- 若 GitHub 权限允许，将远程仓库名称同步调整为 `AgentLink`，并将仓库可见性改为 `public`。

## MVP 范围

- 更新 Android `app_name` 字符串资源。
- 更新 Android Gradle 工程显示名。
- 更新根目录 `README.md` 的项目标题与相关对外命名。
- 新增根目录 `LICENSE`，内容使用标准 MIT License。
- 尝试使用 GitHub CLI 进行仓库改名与可见性调整。

## 非目标

- 不在本次改动中修改 Android 包名或 application id。
- 不在本次改动中迁移本地目录名。
- 不在本次改动中处理应用签名、发布渠道或商店元数据。

## 验收标准

- 安装 APK 后，系统桌面显示的应用名称为 `AgentLink`。
- 项目根目录存在 `LICENSE`，内容为 MIT License。
- `README.md` 顶部项目名称更新为 `AgentLink`。
- 若 GitHub 操作成功，仓库名称更新为 `AgentLink`，并且仓库可见性为 `public`。
- 若 GitHub 操作受限，需明确记录阻塞点和当前状态。
