# dsh-wsl

[English](README.md) | 简体中文

面向模型（model-facing）的 **WSL** 工具插件，用于 DeepSeek Harness（DSH）。它让智能体直接通过 `wsl.exe` 执行 Linux 命令——无需手写 `.sh` 脚本或 `pwsh` 包装。

## 功能

注册一个 `wsl` 工具，其执行形式为：

```
wsl.exe -d Ubuntu-22.04 -e bash -lc "cd <workdir> && <command>"
```

并返回带退出码标记的 `stdout` / `stderr`。

## 安装

1. 将本包加入 DSH 的 profile（`profiles/<profile>/package.json`）：

   ```json
   { "dependencies": { "dsh-wsl": "file:<path-to-this-repo>" } }
   ```

   或运行 `dsh plugin add --profile <profile> file:<path-to-this-repo>`。

2. 在某个 agent preset 的 `agent.cordis.yml` 中加入 `tool-wsl` 行：

   ```yaml
   - id: tool-wsl
     name: 'dsh-wsl'
   ```

3. 重启 DSH。

## 参数

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `command` | 是 | string | 要执行的 Linux 命令 |
| `description` | 是 | string | 简短的界面说明文字 |
| `workdir` | 否 | string | WSL/Linux 路径，默认 `~` |
| `timeoutMs` | 否 | number | 超时时间（毫秒） |

## 注意事项

- 每次调用都在全新的 `bash -lc` shell 中执行——cwd / 变量 / 函数不会在调用间保留。
- 发行版当前硬编码为 `Ubuntu-22.04`；如需修改，改 `index.js` 顶部的 `DEFAULT_DISTRO`。
- 使用 `wsl.exe -e`（`--exec`），引号与 `$VAR` 展开行为与普通 shell 一致；默认的 `--` 透传会破坏单引号和变量。

## 从插件列表安装

本包声明了 `dsh.bundle` manifest（见 `package.json`），因此仓库被列表收录后可按名称安装，例如 `dsh plugin add dsh-wsl`，市场（storefront）也会提供一键安装。上文 `file:` 的本地安装方式仍然有效。

## 工作原理

插件是一个 cordis 模块，注入宿主平面的 `tools` 与 `subprocess` 注册表：

- `apply()` 注册一个 `wsl` 工具，带 JSON-schema 参数定义、输出 schema、`render` 钩子与异步 `execute`。
- `execute()` 通过宿主 `subprocess` 服务执行 `wsl.exe -d Ubuntu-22.04 -e bash -lc "<cd workdir && command>"`：stdin 忽略，stdout/stderr 上限 64 KiB（超出最多落盘到 64 MiB），abort 后有 3 秒宽限期，可选 `timeoutMs` 会中止本次调用。
- 输出为 `{ exitCode, signal, stdout, stderr, truncated }`；`render` 钩子将其格式化为文本，并附加 `[exit code: N]` / `[killed by signal: ...]` / `[output truncated]` 标记。

插件不发布任何自身服务，因此它可以无 realm 地挂在 agent preset 中。

## 开发

插件是纯 ESM，无构建步骤，除 DSH 宿主平面外无运行时依赖。迭代方式：把 profile 依赖指向本仓库：

```json
{ "dependencies": { "dsh-wsl": "file:/path/to/dsh-wsl" } }
```

然后重启 DSH，在包含 `tool-wsl` 行的 preset 会话中调用 `wsl` 工具验证。

可定制点都在 `index.js` 顶部：`DEFAULT_DISTRO`、`DEFAULT_WORKDIR`、输出上限与宽限期。当前发行版硬编码为 `Ubuntu-22.04`。

## 收录

本仓库带有 `dsh-plugin` topic，并已提交至 awesome-dsh-plugin 社区列表的 `wsl` 分类。
