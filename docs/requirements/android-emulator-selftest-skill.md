# Android 模拟器自测与 APK 交付规范

## 背景

当前项目已经具备 Android 客户端、命令行构建链和本机可用的 Android 模拟器，但交付流程仍存在两个问题：

1. 每轮 Android 改动后，未强制执行标准化模拟器自测。
2. `temp_docs/apk/` 中的 APK 交付物未被视为每轮 Android 功能闭环的一部分，容易滞后于最新代码。

这会导致“代码已提交，但实际可安装包未更新”以及“构建通过但模拟器未实装验证”的残留问题。

## 目标

建立一套项目级的 Android 自测约束和技能化流程，使后续 Android 变更默认遵循同一套步骤：

1. Android 功能完成后，必须在本机安装的 Android 模拟器上执行自测。
2. 自测至少覆盖 APK 构建、安装、启动和一次最小链路探针。
3. 自测完成后，必须刷新 `temp_docs/apk/` 中供用户安装验证的最新 APK。
4. 需要提供项目级 skill，约束执行顺序与命令清单，减少临时发挥。

## 范围

本次范围包含：

- `AGENTS.md` 中的协作约束补充
- 项目级 Android 自测 skill
- 配套自测脚本
- 文档中对 Android 自测与 APK 交付流程的说明

## 具体要求

### 1. AGENTS 约束

- 所有功能完成后都必须进行自测。
- 若涉及 Android 客户端改动，默认使用本机安装的 Android 模拟器进行自测。
- 若模拟器不可用，必须明确说明阻塞原因和缺失条件。

### 2. Android 自测标准

Android 自测至少应覆盖：

1. `./gradlew :app:assembleDebug`
2. APK 安装到本机 Android 模拟器
3. App 启动成功
4. 至少一次 hub 连通性或命令探针验证
5. 日志或命令输出中不存在明显致命错误

### 3. APK 交付

- 每次 Android 功能闭环后，都应将最新 debug APK 复制到 `temp_docs/apk/`。
- 该 APK 应与当前已提交代码一致。
- 若 APK 未更新，则该轮 Android 交付视为未完成。

### 4. 项目级 skill

- skill 应放在项目级约定的 skills 目录下。
- skill 需说明何时触发、标准步骤、验证口径与失败时的处理方式。
- 若流程较长，应配套脚本而不是把所有命令堆在 `SKILL.md` 内。

## 非目标

- 不在本轮实现 Android UI 自动化测试框架。
- 不在本轮引入 Espresso、UIAutomator 或云测平台。
- 不要求 release 包签名与发布渠道流程。

## 验收标准

1. `AGENTS.md` 中已加入 Android 模拟器自测约束。
2. 仓库内存在项目级 Android 自测 skill。
3. skill 可驱动一次完整的 APK 构建、安装与基础探针自测。
4. `temp_docs/apk/` 中存在最新可安装 APK，且已在模拟器上完成安装验证。
