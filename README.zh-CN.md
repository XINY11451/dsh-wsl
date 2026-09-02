# dsh-wsl

[English](README.md) | 简体中文

面向模型（model-facing）的 **WSL** 工具插件，用于 DeepSeek Harness（DSH）。它让智能体直接通过 `wsl.exe` 执行 Linux 命令——无需手写 `.sh` 脚本或 `pwsh` 包装。

## 工具

插件注册三个工具：

| 工具 | 用途 |
|---|---|
| `wsl` | 执行 Linux 命令，返回带退出码标记的 `stdout`/`stderr` |
| `wsl-path` | 通过 `wslpath` 在 Windows 与 WSL 路径间互转 |
| `wsl-env` | 汇总 WSL 环境（发行版、内核、CPU、内存、磁盘） |

### `wsl`

执行形式：

```
wsl.exe -d <distro> -e bash -lc "cd <workdir> && <command>"
```

返回 `stdout`/`stderr`，并附加 `[exit code: N]` / `[killed by signal: ...]` /
`[output truncated]` 标记。

### `wsl-path`

双向转换路径：`C:\Users\me\a.txt` → `/mnt/c/Users/me/a.txt`，或
`/home/me/a.txt` → `\\wsl.localhost\Ubuntu-22.04\home\me\a.txt`。方向自动识别，
也可用 `direction: 'win' | 'linux'` 强制指定。

### `wsl-env`

无需参数。返回发行版列表、默认发行版、内核、CPU 数、内存与磁盘占用，让智能体
了解自己运行在什么环境里。

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

## `wsl` 参数

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `command` | 是 | string | 要执行的 Linux 命令 |
| `description` | 是 | string | 简短的界面说明文字 |
| `workdir` | 否 | string | WSL/Linux 路径，默认 `~` |
| `timeoutMs` | 否 | number | 超时时间（毫秒） |
| `distro` | 否 | string | WSL 发行版名称，默认 `Ubuntu-22.04` |
| `env` | 否 | object | 要导出的额外环境变量 |
| `allowDangerous` | 否 | boolean | 置 `true` 才允许执行危险命令 |

## 注意事项

- 每次调用都在全新的 `bash -lc` shell 中执行——cwd / 变量 / 函数不会在调用间保留。
- 默认发行版为 `Ubuntu-22.04`；可用 `distro` 参数逐次覆盖，或用环境变量
  `DSH_WSL_DISTRO` 全局覆盖；修改 `index.js` 顶部的 `DEFAULT_DISTRO` 可改变兜底值。
- `command` 与 `workdir` 中的 Windows 路径（`C:\...`）会自动转换为 `/mnt/c/...`。
- 危险命令（`rm -rf`、往块设备 `dd`、`mkfs`、`shutdown`、fork 炸弹等）默认被拒绝，
  除非调用时显式传 `allowDangerous: true`。
- 使用 `wsl.exe -e`（`--exec`），引号与 `$VAR` 展开行为与普通 shell 一致；
  默认的 `--` 透传会破坏单引号和变量。

## 从插件列表安装

本包声明了 `dsh.bundle` manifest（见 `package.json`），因此仓库被列表收录后可按
名称安装，例如 `dsh plugin add dsh-wsl`，市场（storefront）也会提供一键安装。
上文 `file:` 的本地安装方式仍然有效。

## 工作原理

插件是一个 cordis 模块，注入宿主平面的 `tools` 与 `subprocess` 注册表：

- `apply()` 注册三个工具，每个都有 JSON-schema 参数定义、输出 schema、`render`
  钩子与异步 `execute`。
- `execute()` 通过宿主 `subprocess` 服务执行 `wsl.exe -d <distro> -e bash -lc
  "<cd workdir && command>"`：stdin 忽略，stdout/stderr 上限 64 KiB（超出最多落盘
  到 64 MiB），abort 后有 3 秒宽限期，可选 `timeoutMs` 会中止本次调用。
- `env` 条目在命令前部以 `export` 形式注入，确保可靠到达 Linux 侧；Windows 盘符
  路径在构造命令前先改写为 `/mnt/...`。
- 输出为 `{ exitCode, signal, stdout, stderr, truncated }`；`render` 钩子将其格式化
  为文本，并附加 `[exit code: N]` / `[killed by signal: ...]` / `[output truncated]` 标记。
- 危险命令防护在 dispatch 前对最终命令串做匹配，命中且未设 `allowDangerous` 时拒绝。

插件不发布任何自身服务，因此它可以无 realm 地挂在 agent preset 中。

## 开发

插件是纯 ESM，无构建步骤，除 DSH 宿主平面外无运行时依赖。迭代方式：把 profile
依赖指向本仓库：

```json
{ "dependencies": { "dsh-wsl": "file:/path/to/dsh-wsl" } }
```

然后重启 DSH，在包含 `tool-wsl` 行的 preset 会话中调用工具验证。

可定制点都在 `index.js` 顶部：`DEFAULT_DISTRO`、`DEFAULT_WORKDIR`、输出上限、宽限期
与危险模式列表。

## 收录

本仓库带有 `dsh-plugin` topic，并已提交至 awesome-dsh-plugin 社区列表的 `wsl` 分类。
