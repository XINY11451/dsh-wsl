# dsh-wsl

[English](README.md) | 简体中文

面向模型（model-facing）的 **WSL** 工具插件，用于 DeepSeek Harness（DSH）。它让智能体直接通过 `wsl.exe` 执行 Linux 命令——无需手写 `.sh` 脚本或 `pwsh` 包装。

## 工具

插件注册三个工具：

| 工具 | 用途 |
|---|---|
| `wsl` | 执行 Linux 命令，返回带退出码、超时与截断标记的 `stdout`/`stderr` |
| `wsl-path` | 通过 `wslpath` 在 Windows 与 WSL 路径间互转 |
| `wsl-env` | 汇总 WSL 环境（发行版、内核、CPU、内存、磁盘） |

### `wsl`

执行形式：

```
wsl.exe -d <distro> -e bash -lc "cd <workdir> && <command>"
```

返回 `stdout`/`stderr`，并附加 `[exit code: N]` / `[killed by signal: ...]` /
`[timed out after Nms; the command was killed]` / `[output truncated: ...]` 标记。

超过 Windows 命令行上限（32767 字符）的脚本会改为通过 **stdin** 交给
`wsl.exe -d <distro> -e bash -ls` 执行，因此长命令没有体积上限。

### `wsl-path`

双向转换路径：`C:\Users\me\a.txt` → `/mnt/c/Users/me/a.txt`，或
`/home/me/a.txt` → `\\wsl.localhost\Ubuntu-22.04\home\me\a.txt`。方向自动识别，
也可用 `direction: 'win' | 'linux'` 强制指定。

### `wsl-env`

返回发行版列表、被探测的发行版、内核、CPU 数、内存与磁盘占用，让智能体了解自己
运行在什么环境里。可传可选参数 `distro`。探测失败会写进摘要而不是被丢掉；发行版
不存在则直接报错，而不是给出一份残缺答案。

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
| `workdir` | 否 | string | Linux 路径（`/home/me`、`~/src`）或 Windows 路径，默认 `~` |
| `timeoutMs` | 否 | number | 超时毫秒数；到点后杀进程并把结果标记为超时 |
| `distro` | 否 | string | WSL 发行版名称，默认 `Ubuntu-22.04` |
| `env` | 否 | object | 要导出的额外环境变量（键必须是合法 shell 变量名） |
| `allowDangerous` | 否 | boolean | 置 `true` 才允许执行危险命令 |
| `translatePaths` | 否 | boolean | 默认 `true`；置 `false` 时 `command` 原样传入，不做路径改写 |

## 注意事项

- 每次调用都在全新的 shell 中执行——cwd / 变量 / 函数不会在调用间保留。
- 默认发行版为 `Ubuntu-22.04`；可用 `distro` 参数逐次覆盖，或用环境变量
  `DSH_WSL_DISTRO` 全局覆盖；修改 `index.js` 顶部的 `DEFAULT_DISTRO` 可改变兜底值。
- 发行版不存在时会给出明确报错（`distribution "X" is not registered`），而不是
  一个原始 `-1` 退出码。
- `command` 与 `workdir` 中的 Windows 路径会自动转换为 `/mnt/...`：
  - `C:\Users\me\a.txt` → `/mnt/c/Users/me/a.txt`；含空格的路径两种斜杠写法都支持
    （`C:\Program Files\Git` 与 `C:/Program Files/Git` 均 → `/mnt/c/Program Files/Git`）；
  - `\\wsl.localhost\<发行版>\home\x` 与 `\\wsl$\<发行版>\home\x` → `/home/x`；
  - 单个小写字母后跟 `/`（如 `a:/b`）不改写——这种写法是普通文本的可能性远大于盘符；
  - 当路径要交给**Windows 程序**（经 interop 调用）时请传 `translatePaths: false`：
    WSL 不会把 `/mnt/c/...` 反向翻译，`notepad.exe C:\file.txt` 需要原始写法。
- `workdir` 与 `wsl-path` 参数中的 `~` 会被 shell 展开（`~/my dir` 可用）。其余路径
  一律单引号包裹，因此路径里的 `$VAR` **不会**展开。
- 每条流输出上限 64 KiB：保留尾部，标记中会给出保存**完整**输出的落盘文件路径，
  信息不会不可恢复：

  ```
  [stdout truncated: kept the last 65536 of 1288895 bytes; full stream: C:\...\stdout.log]
  ```
- `timeoutMs` 到点会连 Linux 侧进程一起杀掉（Windows 上由 provider 使用 `taskkill /T /F`）。
- 危险命令默认被拒绝，除非调用时传 `allowDangerous: true`。防护针对**最终**命令串，
  嵌套写法同样命中，并覆盖分开写与长选项写法：`rm -rf`、`rm -r -f`、`rm -R --force`、
  `rm --recursive --force`、`sudo rm -r -f`、`bash -c "rm -rf /"`、`find . -exec rm -rf {} +`；
  混淆写法会在匹配前归一化（`rm$IFS-rf`、`rm${IFS}-rf`、`\rm -rf`、`$(which rm) -rf`）。
  同时拒绝往块设备 `dd`、`mkfs`/分区/擦除类工具、电源控制、重定向到块设备与 fork 炸弹。
- stderr 中重复出现的启动器噪声会被过滤：localhost 代理警告与 procps 的
  `screen size is bogus` 行。
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
- 所有调用都走同一条 spawn 路径（`spawnWsl`）：通过宿主 `subprocess` 执行
  `wsl.exe -d <distro> -e bash -lc "<exports; cd workdir && command>"`，stdout/stderr
  上限 64 KiB（超出最多落盘 64 MiB），abort 后有 3 秒宽限期，可选 `timeoutMs` 中止
  调用。插件自身的探测调用另有 30 秒硬上限，避免 WSL 服务卡死时永久挂住工具调用。
- `env` 条目在命令前部以 `export` 形式注入，确保可靠到达 Linux 侧；Windows 盘符
  路径在构造命令前先改写为 `/mnt/...`。
- 输出为 `{ exitCode, signal, timedOut, truncated, stdout, stderr, stdoutTotalBytes,
  stdoutDroppedBytes, stderrTotalBytes, stderrDroppedBytes, stdoutSpillPath,
  stderrSpillPath }`；`render` 钩子将其格式化为文本并附加上述标记。
- 危险命令防护在 dispatch 前对最终命令串做匹配，命中且未设 `allowDangerous` 时拒绝。

插件不发布任何自身服务，因此它可以无 realm 地挂在 agent preset 中。

## 开发

插件是纯 ESM，无构建步骤，除 DSH 宿主平面外无运行时依赖。迭代方式：把 profile
依赖指向本仓库：

```json
{ "dependencies": { "dsh-wsl": "file:/path/to/dsh-wsl" } }
```

然后重启 DSH，在包含 `tool-wsl` 行的 preset 会话中调用工具验证。

### 测试

```sh
npm test          # 100+ 项检查，跑在真实 WSL 上，仅用 shim 顶替 ctx.subprocess
npm run test:real # 同样的 seam 事实，改为对真实 DSH provider 校验
```

`npm test` 只替换 `ctx.subprocess`，用一个复刻了 seam 行为（有界尾窗、落盘文件、
终止阶梯）的 shim 驱动三个工具跑在真实 WSL 上，覆盖路径改写、workdir 引号处理、
危险命令防护、退出码/超时/截断标记、`wsl-path`、`wsl-env` 与参数校验。

`npm run test:real` 校验 shim 无法担保的 seam 事实：`readFrom(0).nextOffset` 是否是
整条流的字节总数、落盘文件是否完整、超时是否真的杀掉了 `wsl.exe` 的 Linux 侧进程。
它需要一份 DSH 安装，未指定时自动跳过：

```sh
DSH_SUBPROCESS_LOCAL=/path/to/dsh/node_modules npm run test:real
```

可定制点都在 `index.js` 顶部：`DEFAULT_DISTRO`、`DEFAULT_WORKDIR`、输出上限、
宽限期、内部超时上限与危险模式列表。

## 收录

本仓库带有 `dsh-plugin` topic，并已提交至 awesome-dsh-plugin 社区列表的 `wsl` 分类。
