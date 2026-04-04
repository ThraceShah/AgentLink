# 本地开发说明

## 依赖

- Node.js 20+
- npm 10+
- JDK 17+
- Android SDK（仅 Android 客户端构建需要）

当前环境未要求数据库、MQ、Redis 或容器平台。

## 启动顺序

1. `npm install`
2. `npm run dev:hub`
3. 准备本机真实可用的 agent CLI，例如 `qwen`、`opencode`、`codex` 或 `copilot`
4. 启动一个 tmux-backed bridge，例如 `npm run dev:tmux-agent`

## 运行测试

```bash
npm test
```

## 运行 demo

```bash
npm run demo
```

## 运行 tmux demo

```bash
npm run demo:tmux
```

## 运行 Codex bridge

```bash
npm run dev:codex-bridge
```

## Android 客户端命令行构建

首次构建前，确保本机已设置：

- `JAVA_HOME`
- `ANDROID_SDK_ROOT`
- `ANDROID_HOME`

在 `android-client/` 下执行：

```bash
./gradlew :app:assembleDebug
```

若只需要刷新 wrapper：

```bash
./gradlew wrapper
```
