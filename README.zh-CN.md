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
wsl.exe [-d <distro>] -e bash -lc "cd <workdir> && <command>"
```

返回 `stdout`/`stderr`，并附加 `[exit code: N]` / `[killed by signal: ...]` /
`[timed out after Nms; the command was killed]` / `[output truncated: ...]` 标记。

`<distro>` 取调用参数 `distro`，其次 `DSH_WSL_DISTRO`，都没有时**完全不传 `-d`**，
由 `wsl.exe` 使用**系统默认发行版**——这正是本插件能装到没有 `Ubuntu-22.04` 的机器上的原因。

超过 Windows 命令行上限（32767 字符）的脚本会改为通过 **stdin** 交给
`wsl.exe [-d <distro>] -e bash -ls` 执行，因此长命令没有体积上限。

传 `stdin` 可以把文本喂给命令（默认是 `/dev/null`，交互式命令会立刻 EOF）；传
`runInBackground: true` 则把命令交给宿主的任务注册表，模型随后用**已有的**
**`job_output`** 工具读它、用 **`job_kill`** 停它——不需要任何新工具。后台任务需要
preset 组合里有 `@deepseek-ai/dsh-tool-jobs`；没有时会直接报错说明，而不是悄悄退化成
前台执行。

### `wsl-path`

双向转换路径：`C:\Users\me\a.txt` → `/mnt/c/Users/me/a.txt`，或
`/home/me/a.txt` → `\\wsl.localhost\Ubuntu-22.04\home\me\a.txt`。方向自动识别，
也可用 `direction: 'win' | 'linux'` 强制指定。

### `wsl-env`

返回发行版列表、被探测的发行版、内核与架构、CPU 数、内存与磁盘占用，以及这台机器
**实际能做什么**：

```
distro: Ubuntu-22.04 (system default)
Linux 6.6.87.2-microsoft-standard-WSL2 x86_64
nproc: 24
Ubuntu 22.04.5 LTS · WSL2 · cgroup v2
systemd: yes · docker: not installed
GPU: /dev/dxg present (GPU passthrough enabled) · nvidia-smi: GPU 0: NVIDIA GeForce RTX 5070 Laptop GPU
drives: /mnt/c /mnt/d
/etc/wsl.conf: [boot];systemd=true;[user];default=xiny; · .wslconfig: not set
launcher: WSL 版本: 2.6.3.0 · 内核版本: 6.6.87.2-1 · WSLg 版本: 1.0.71 · Windows: 10.0.26200.9457
```

让智能体在动手前就知道有什么可用：WSL1 还是 WSL2、服务是否由 systemd 托管、cgroup 版本
（容器相关）、GPU 直通、docker（未装／只有 CLI／守护进程版本）、挂载了哪些盘，以及
`/etc/wsl.conf` 与 Windows 侧 `.wslconfig` 的配置。可传可选参数 `distro`。

每一项都是可选的，且如实降级：探针没跑成的行会被省略，读到了但为空的值会写明
（`docker: not installed`、`.wslconfig: not set`），探测失败会写进摘要而不是被丢掉，
发行版不存在则直接报错，而不是给出一份残缺答案。注意 `wsl --version` 输出是**本地化**的，
因此其标签按启动器原样透传、不按名称解析；Direct3D/MSRDC/DXCore 版本作为噪声被省略。

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
| `timeoutMs` | 否 | number | 超时毫秒数，默认 600000（10 分钟）；到点后杀进程并把结果标记为超时 |
| `distro` | 否 | string | WSL 发行版；默认使用系统默认发行版 |
| `env` | 否 | object | 要导出的额外环境变量（键必须是合法 shell 变量名） |
| `stdin` | 否 | string | 在命令运行前写入其 stdin 的文本（UTF-8） |
| `runInBackground` | 否 | boolean | 作为后台任务运行并立即返回任务 id；用 `job_output` 读、`job_kill` 停 |
| `allowDangerous` | 否 | boolean | 置 `true` 才允许执行危险命令 |
| `translatePaths` | 否 | boolean | 默认 `true`；置 `false` 时 `command` 原样传入，不做路径改写 |

## 配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_WSL_DISTRO` | （系统默认） | 为所有调用固定发行版 |
| `DSH_WSL_TIMEOUT_MS` | `600000` | 模型命令的默认超时；单次调用可用 `timeoutMs` 覆盖 |
| `DSH_WSL_MAX_TIMEOUT_MS` | `86400000` | 单次 `timeoutMs` 的上限，对齐平台 shell 工具的 `maxTimeoutMs`；默认超时也受它约束 |
| `DSH_WSL_MAX_OUTPUT_BYTES` | `65536` | 每条流的内存窗口（1 KiB – 8 MiB）；设到 64 MiB 以上时也会抬高落盘上限 |
| `DSH_WSL_WORKDIR` | `home` | 不传 `workdir` 时的起点：`home`（Linux 的 `~`）、`session`（会话工作目录，Windows 检出对应 `/mnt/<盘>/...`），或任意显式路径 |

无法解析或越界的值会回退到默认值——一个写错的环境变量不该让三个工具一起挂掉。
配置在挂载时读取一次，改动需重启 DSH 生效。

## 注意事项

- 每次调用都在全新的 shell 中执行——cwd / 变量 / 函数不会在调用间保留。
- **stdin 默认是 `/dev/null`，除非传 `stdin`**：交互式命令（`read`、`cat`、不带 `-S`
  的 `sudo` 密码提示）否则会立刻收到 EOF，无法等待输入；本插件不会、也无法弹出任何提示。
  通过 `stdin` 传的密码会被记进会话记录。
- `workdir` 默认 `~`；设 `DSH_WSL_WORKDIR=session` 可改为从会话工作目录开始（见"配置"）。
- 发行版取调用参数 → `DSH_WSL_DISTRO` → 系统默认，代码里不再硬编码兜底名称。
- 发行版不存在时会给出明确报错（`distribution "X" is not registered`），而不是
  一个原始 `-1` 退出码；其他启动器错误（`Wsl/Service/WSL_E_*`）也会带错误码上报，
  不会被当成命令自身的退出状态。
- **后台任务可以活得比这次调用久**：`runInBackground: true` 立即返回任务 id（`wsl-N`）
  并把工作登记进宿主任务注册表，`job_output` 读它（标记与前台一致）、`job_kill` 停它。
  后台模式下 10 分钟默认超时**不适用**，但显式 `timeoutMs` 仍然生效；非零退出与前台一样
  报成 `completed` 并把退出码写进 detail。
- `command` 与 `workdir` 中的 Windows 路径会自动转换为 `/mnt/...`：
  - `C:\Users\me\a.txt` → `/mnt/c/Users/me/a.txt`；含空格、括号的路径与一行多个路径都支持
    （`C:\Program Files\Git`、`C:/Program Files/Git`、`C:\Program Files (x86)\Steam`、
    `cp C:\a.txt D:\b.txt` 两个路径都会转换）；
  - `\\wsl.localhost\<发行版>\home\x` 与 `\\wsl$\<发行版>\home\x` → `/home/x`；
  - 只是"看起来像"盘符的文本不会被动：单个小写字母后跟 `/`（如 `a:/b`）、其他表达式里的
    盘符（如 `sed "s/C:\x/y/"`）、URL 里的疑似盘符段；
  - 当路径要交给**Windows 程序**（经 interop 调用）时请传 `translatePaths: false`：
    WSL 不会把 `/mnt/c/...` 反向翻译，`notepad.exe C:\file.txt` 需要原始写法。
    该开关只影响 `command`；`workdir` 始终会被转换。
- `workdir` 与 `wsl-path` 参数中的 `~` 会被 shell 展开（`~/my dir` 可用）。其余路径
  一律单引号包裹，因此路径里的 `$VAR` **不会**展开。
- 每条流输出上限 64 KiB：保留尾部，标记中会给出保存**完整**输出的落盘文件路径，
  信息不会不可恢复：

  ```
  [stdout truncated: at most the last 65536 of 1288895 bytes were kept; full stream: C:\...\stdout.log]
  ```
- `timeoutMs` 默认 10 分钟，避免卡死的 `wsl.exe` 永久挂住调用；需要长时间运行的命令可以传更大的值，
  但上限是 `DSH_WSL_MAX_TIMEOUT_MS`（默认 24 小时）——手滑不会变成"永不超时"。结果里回报的始终是
  **实际生效**的那个期限。到点会连 Linux 侧进程一起杀掉（Windows 上由 provider 使用 `taskkill /T /F`）。
- **宿主 shell 的环境事实会转发进发行版**（WSL 默认不跨边界传 Windows 环境变量）：`DSH_SESSION_ID`、
  `DSH_SHELL`、以及翻译成 `/mnt/...` 形式的 `DSH_HOME` 会在命令前 `export`，脚本因此能看到与平台自带
  shell 工具一致的会话事实。**`DSH_WEB_URL` 故意不转发**——它是 Windows 侧服务的 `127.0.0.1` 地址，
  而默认 NAT 模式下 WSL 访问不到 Windows 回环（实测 `127.0.0.1` 与主机 IP 均返回 HTTP 000，服务本身
  也只绑回环），转进去只会给一个打不开的 URL。显式传入的 `env` 条目总是覆盖转发值。
- `wsl-env` 还会报出**会话文件所在的位置**以及它是否落在 Windows 盘挂载上：

  ```
  workspace: /mnt/d/DSHworkarea (Windows drive mount /mnt/d — builds, installs and git are much slower here; prefer a path under /home when it matters)
  ```

  这个提示值得当真。作者机器实测：128 MB 顺序写在 ext4 上约 **2.1 GB/s**，在 `/mnt/d` 上约 **247 MB/s**；
  创建 400 个小文件 ext4 **不到 10 ms**，`/mnt/d` 要 **0.72 s**。
- 危险命令默认被拒绝，除非调用时传 `allowDangerous: true`：
  - **任何递归删除**——`rm -r`、`rm -rf`、`rm -r -f`、`rm -R --force`、`rm --recursive`——
    因为 stdin 指向 `/dev/null` 时不会产生任何提示，`rm -r tree` 会静默删除整棵树。
    每次 `rm` 调用按其所在命令段单独判定，所以 `rm a -f; rm b -r` 不能靠拼接标志蒙过去；
  - 往块设备 `dd`、`mkfs`、分区/擦除类工具（`fdisk`、`parted`、`wipefs`、`mkswap` …）、
    电源控制（`shutdown`、`reboot`、`systemctl reboot` …）、重定向到块设备、fork 炸弹；
  - 防护容忍命令词的各种写法（`sudo rm -r -f`、`bash -c "rm -rf /"`、
    `find . -exec rm -rf {} +`、`rm$IFS-rf`、`\rm -rf`、`$(which rm) -rf`），但设备/电源类
    工具只在**命令位置**匹配，因此查看它们是允许的：`man fdisk`、
    `grep -rn reboot /var/log/syslog`、`echo "the mkfs tool formats disks"` 都能正常执行。
- stderr 中重复出现的启动器噪声会被过滤：localhost 代理警告与 procps 的
  `screen size is bogus` 行。
- 使用 `wsl.exe -e`（`--exec`），引号与 `$VAR` 展开行为与普通 shell 一致；
  默认的 `--` 透传会破坏单引号和变量。

## 沙箱边界

DSH 的文件沙箱在**两个点**实施：shell 执行器（`@deepseek-ai/dsh-bash-sandbox`、`-pwsh-sandbox`，把
argv 包一层过 `ctx.sandbox`）和文件系统服务（`@deepseek-ai/dsh-fs-sandbox`，对两个写操作加策略栅栏）。
**`wsl` 两者都不经过**——它通过宿主 `subprocess` 服务直接拉起 `wsl.exe`，位于那一层之下。因此
`workspace-write` 策略**约束不到它**：它能写 Linux 侧能写的任何位置，也能写 `/mnt/<盘>` 下 Windows
允许的任何位置。

这不是靠"接入沙箱"能补上的缺口。Windows 上的沙箱最终落到 **ACL / 受限令牌**，而文件操作发生在
**Linux 内核里**：写 `/home/...` 动的是发行版自己的文件系统镜像，任何 Windows 令牌都够不着；写
`/mnt/c/...` 要经文件系统桥，ACL 是否生效不可依赖。把 `wsl.exe` 包起来只能约束"启动器"，约束不了写入
——而给出**虚假的隔离感，比明说不隔离更危险**。（平台自己的 `dsh-fs-sandbox` 也坦白它的边界：
"containment, not a security boundary"。）

`wsl` 实际拥有的保护是上面那套危险命令守卫：一份确定性的拒绝清单，**不是内核边界**。请把它当作
"能碰到你的 WSL 安装能碰的一切"来授予权限。

## 从插件列表安装

本包声明了 `dsh.bundle` manifest（见 `package.json`），因此仓库被列表收录后可按
名称安装，例如 `dsh plugin add dsh-wsl`，市场（storefront）也会提供一键安装。
上文 `file:` 的本地安装方式仍然有效。

## 工作原理

插件是一个 cordis 模块，注入宿主平面的 `tools` 与 `subprocess` 注册表。`index.js`
只是入口，实现按职责拆分：

| 模块 | 职责 |
|---|---|
| `lib/config.js` | 默认值与环境变量覆盖，挂载时解析一次 |
| `lib/paths.js` | shell 引号处理与 Windows → WSL 路径转换 |
| `lib/guard.js` | 危险命令规则 |
| `lib/result.js` | 启动器噪声过滤、截断事实、标记渲染 |
| `lib/diagnostics.js` | `wsl-env` 的能力探针、解析器与输出行 |
| `lib/runner.js` | 唯一的 spawn 路径与启动器错误分类 |
| `lib/tools/*.js` | 三个工具定义（schema / execute / presentCall） |

- `apply()` 解析配置并注册三个工具，每个都有 JSON-schema 参数定义、输出 schema、
  `render` 钩子与异步 `execute`。
- 所有调用都走同一条 spawn 路径（`runner.runWsl`）：通过宿主 `subprocess` 执行
  `wsl.exe -d <distro> -e bash -lc "<exports; cd workdir && command>"`，stdout/stderr
  上限由配置决定（超出最多落盘 64 MiB），abort 后有 3 秒宽限期，超时默认 10 分钟。
  插件自身的探测调用另有 30 秒硬上限，避免 WSL 服务卡死时永久挂住工具调用。
- `env` 条目在命令前部以 `export` 形式注入，确保可靠到达 Linux 侧；Windows 盘符
  路径在构造命令前先改写为 `/mnt/...`。
- 输出为 `{ exitCode, signal, timedOut, timeoutMs, truncated, stdout, stderr,
  stdoutTotalBytes, stdoutDroppedBytes, stderrTotalBytes, stderrDroppedBytes,
  stdoutSpillPath, stderrSpillPath, jobId }`；`render` 钩子将其格式化为文本并附加上述
  标记。截断标记引用窗口大小本身而不是由解码文本推算的数字——窗口起点落在多字节字符
  中间时后者会差一两个字节。
- `jobId` 只有后台启动才会赋值，其余路径一律 `null`，因此两种情况下声明形状都成立。
- 启动与结算被拆成两步（`runner.launch` / `settle`）：后台任务要同步交给注册表一对
  `cancel`/`done`，而前台调用只是 await 同一个 settle。被取消的任务会把 provider 的
  "target 启动前即被终止"拒绝映射成 `killed`——`JobHooks.done` 不允许 reject。
- 危险命令防护把命令按 `;`／`&`／`|`／换行切成段，每次 `rm` 调用按自身标志单独判定，
  设备/电源类工具在命令位置匹配后才拦截。

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
npm test          # 260+ 项检查，跑在真实 WSL 上，仅用 shim 顶替 ctx.subprocess
npm run test:real # 同一套检查改跑真实 provider，外加 seam 事实套件
```

`npm test` 只替换 `ctx.subprocess`，用一个复刻了 seam 行为（有界尾窗、落盘文件、
终止阶梯）的 shim 驱动三个工具跑在真实 WSL 上，覆盖路径改写、workdir 引号处理、
危险命令防护、发行版选择、退出码/超时/截断标记、`wsl-path`、`wsl-env`、参数校验、
配置解析、启动器错误分类、返回结构与各自 `output.schema` 的一致性，以及模型可见
目录的 token 预算。

`npm run test:real` 把同一套检查改跑在 `LocalSubprocessRuntime` 上——shim 不允许与
真实 seam 漂移——然后跑 `test/real-seam.mjs`，校验 shim 无法担保的事实
（`readFrom(0).nextOffset` 是否为整条流字节总数、落盘文件是否完整、超时是否真的杀掉
`wsl.exe` 的 Linux 侧进程），并用 DSH 自己的 `assertSupportedJsonSchema` 校验全部
schema。它需要一份 DSH 安装：

```sh
DSH_SUBPROCESS_LOCAL=/path/to/dsh/node_modules npm run test:real
```

### 同步到 profile

`file:` 依赖是**副本**，改本仓库不会改变 DSH 实际加载的内容。任何改动之后：

```sh
npm run sync                  # 复制到 ~/.dsh/profiles/web/node_modules/dsh-wsl
npm run sync -- /path/to/profiles/<profile>/node_modules/dsh-wsl
```

然后重启 DSH——插件在加载时只导入一次。

## 收录

本仓库带有 `dsh-plugin` topic，并已提交至 awesome-dsh-plugin 社区列表的 `wsl` 分类。
