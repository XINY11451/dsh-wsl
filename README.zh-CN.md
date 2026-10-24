# dsh-wsl

[English](README.md) | 简体中文

面向模型（model-facing）的 **WSL** 工具插件，用于 DeepSeek Harness（DSH）。它让智能体直接通过
`wsl.exe` 执行 Linux 命令——无需手写 `.sh` 脚本或 `pwsh` 包装——并且在**命令执行**这一层基本对齐
Linux 原生 DSH：真实的 Linux 内核与 bash、退出码与信号、超时、截断与落盘、可用内置 job 工具读回的
后台作业、stdin，以及 Windows/WSL 路径自动转换。

它也能像你一样地干活：在**一个能保持状态的 shell** 里，一件事一个 shell，每条命令都连同退出码留下记录，
输入框上方只显示一行紧凑的子任务数量；当你**点名自己打开的终端**时，键盘点一下就能拿回来。

有两点限制值得在依赖它之前知道：`wsl` 调用位于 DSH 沙箱层之下，文件策略约束不到它
（见[沙箱边界](#沙箱边界)）；项目放在 Windows 盘上时仍是 **Windows** 的文件系统语义——没有 POSIX
权限位、文件名大小写不敏感、收不到文件变更通知——速度也低一个数量级（见[注意事项](#注意事项)）。

![功能一览，按重要性排列](assets/market-preview-features-9.png)

## 工具

插件注册十个工具。除 `wsl-term` 外每个都有独立开关，其中 `wsl-doctor` 与 `wsl-bootstrap` **默认关**：

| 工具 | 用途 |
|---|---|
| `wsl` | 执行 Linux 命令，返回带退出码、超时与截断标记的 `stdout`/`stderr` |
| `wsl-path` | 通过 `wslpath` 在 Windows 与 WSL 路径间互转 |
| `wsl-env` | 汇总 WSL 环境（发行版、内核、CPU、内存、磁盘） |
| `wsl-doctor` | 对照项目清单与发行版实际能力，指出缺什么——包括那些其实是 Windows 二进制的命令。只读，**默认关**（需要诊断时再开） |
| `wsl-bootstrap` | 按固定配方在发行版里补装缺失的工具链，先出计划再动手 |
| `wsl-term` | 在本会话的终端里工作：一件事一个 shell，每件事都在输入框上方留下记录 |
| `wsl-read` | 读取发行版里的文本文件，整份或按行范围；二进制与非 UTF-8 直接拒绝 |
| `wsl-write` | 写入发行版里的文本文件，原子替换，父目录自动创建 |
| `wsl-edit` | 在发行版里的文件中替换唯一匹配的字符串 |
| `wsl-grep` | 在发行版里按正则搜索文件内容，按文件分组返回带行号的匹配行 |

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

### `wsl-doctor`

回答一个项目自己的 README 答不了的问题：**这份代码指望的工具链，在这套发行版里真的能用吗？**
它读取目录里的清单（`package.json` 与各种 lockfile、`.nvmrc`、`tsconfig.json`、`Cargo.toml`、
`go.mod`、`pyproject.toml`、`requirements.txt`、`Dockerfile`、`docker-compose.yml`、`Makefile`、
`CMakeLists.txt`），然后逐项给出它在 Linux 侧的位置：

```
distro: Ubuntu-22.04 (system default)
workspace: /mnt/d/proj (Windows drive mount /mnt/d — builds, installs and git are much slower here; …)
project: package.json, pnpm-lock.yaml

needs (from the project): node, npm, pnpm
  MISSING node — not on PATH in this distribution (from package.json)
  WINDOWS npm — resolves to /mnt/c/Program Files/nodejs/npm, a Windows binary reached through interop; …
  MISSING pnpm — not on PATH in this distribution (from pnpm-lock.yaml)

usable on the Linux side: python3 3.10.12, gcc 11.4.0, make 4.3, git 2.34.1, curl, rsync, tar, sudo
Windows binaries on the Linux PATH (interop): npm -> /mnt/c/Program Files/nodejs/npm, npx -> …
privileges: uid=1000 (xiny) · sudo: requires a password (unusable from a tool call) · root: switched off

next: node, npm are not usable — wsl-bootstrap({ recipes: ["node", "pnpm"] }) installs them …
```

那行 `WINDOWS` 就是它存在的理由。WSL 会把 Windows 的 `PATH` 接到 Linux 的后面，于是
`npm` 在一套**根本没有 `node`** 的发行版里"找得到"（本机实测就是
`/mnt/c/Program Files/nodejs/npm`），模型拿它去跑 Linux 目录时报的错两头都不沾。整体只读、
开销很小，值得在把失败归咎于命令本身之前先跑一次。可选参数 `workspace`（Linux 目录；默认取
配置的目录，否则取会话工作区）与 `distro`。

### `wsl-bootstrap`

**在发行版内部**补装缺失的工具链，只认固定配方：`node`（Node.js LTS 装进 `/usr/local`，
校验 sha256，并启用 corepack）、`pnpm`、`python`（python3 + pip + venv）、`build`
（build-essential）、`tools`（jq、rsync、curl、git、ca-certificates）。依赖按需带上：
`pnpm` 会带上 `node`，`curl` 缺失时 `node` 会带上 `tools`。

**它默认关**，且 `dryRun` 默认为 `true`，所以第一次调用只打印计划、什么都不改：

```
dry run — nothing has been installed (distro Ubuntu-22.04)

already present:
  python — python3, pip and venv (apt)

to install (python, tools):
  [tools] apt packages: ca-certificates curl git jq rsync — runs as root inside the distribution
      export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y ca-certificates curl git jq rsync

apt would report:
  Inst libjq1 (1.6-2.1ubuntu3.2 Ubuntu:22.04/jammy-updates [amd64])
  …

run it for real with `dryRun: false`.
```

已经满足的配方会被跳过；计划里包含 apt 自己会做什么，因此安装前就能看到具体改动。安装以 root 执行；
某一步失败即停下并附上它的输出末尾。

### `wsl-term`

这里其他工具都是**每次调用开一个全新 shell**，这让它们可以安全并行，也是默认方式。`wsl-term` 反过来：
**一件事一个 shell**。它适合那些"shell 自身状态就是重点"的活——想看着它跑完的构建、交互式程序、
必须在多步之间保留的目录或环境。

`wsl-term` 就在这个终端里工作：

```
wsl-term({ action: "list" })                                  → 有哪些终端
wsl-term({ action: "read" })                                  → 当前屏幕
wsl-term({ action: "run", command: "make sta", subtask: "跑通 sta 流程" })
                                                              → 在那个终端里执行，返回输出与退出码
wsl-term({ action: "input", data: "ls", submit: true })       → 原始按键
wsl-term({ action: "interrupt" })                             → Ctrl-C
wsl-term({ action: "close", id: "…" })                        → 关闭你点名的那个终端
wsl-term({ action: "subtask-done", subtask: "跑通 sta 流程", result: "三条连跑全通过" })
                                                              → 写下结果，并决定这个 shell 的去留
```

**它驱动哪个 shell：两条规则，区别在 `subtask` 参数。**

- **带 `subtask` 的 `run` 是「被记录的任务」。** 它用**工具自己开的私有 WSL shell**：一件事一个 shell，
  每条命令记在输入框上方，`subtask-done` 决定闲置还是关掉它。它不在侧边栏里，只有工具往里打字——
  子任务的管理动作永远不碰你打开的终端。
- **不带 `subtask` 的命令是「终端协作」。** `run`、`read`、`input`、`interrupt` 使用**你开着的那个最新终端**，
  命令在你眼前执行、屏幕你随时能读；工具工作期间它是只读的，点 **「接管输入」** 就能继续输入。
  工具**永远不会关闭**你打开的终端。
- **显式点名 `id` 的调用最优先**，不管那是不是你开的终端。

如果你一个终端都没开，不带 `subtask` 的命令也会开一个私有 shell——那是本会话可用的 shell，但**不会出现在侧边栏**。
协作这一半靠桥接实现：从 DSH 0.2.1 起宿主不再允许插件直接附着浏览器终端，但本插件自己的**浏览器半**运行在页面里，
那个附着在页面里是允许的，于是宿主把 `attach`/`write`/`detach` 命令经两条同源路由交给它（不额外开端口、不额外起服务）。
旧代宿主（≤0.2.0）已不受支持：终端工具会明确报告无法驱动，而不是通过 `follow`/`write` 直接操作你的终端。

#### 每件事都留下一条记录

在 `run` 上给出 `subtask`，就会为这件事开一条记录，并记下它跑过的每条命令和退出码。输入框上方的显示默认只写
**这次对话跑过多少个子任务**（以及几个还在运行）；点一下 **展开** 才会列出来：**正在运行的排在最上面**，已经结束的
带着结果排在后面；再点开一行会看到详情——终端的完整描述、结果、以及每条命令。`subtask-done` 负责写下结果并决定
这个 shell 的去留：`keepTerminal: true`（默认）把它闲置着等你下一步，`false` 则关掉**工具自己开的**那个 shell；
**你自己开的终端永远不会被这样关掉**，要关就用 `close`（它同样拒绝关闭不是工具开的终端）。
dock 里也会列出**你打开的终端**，标注为「用户建立的终端」：开着的时候显示「使用中」，只有**你自己关掉**它之后才变成「已结束」。
这些记录只存在**本次 DSH 运行**的内存里：它们描述的是这次对话做过的事，重启会连同终端一起清空。

终端属于**本次 DSH 运行**，重启即结束；应用在重新创建浏览器终端时会给它一个**新的 id**，所以早前消息里的 id
可能已经不存在——这时工具会退到它自己的某个 shell，并说明用了哪一个。

用之前有几点要知道：

- **你开着的终端在模型工作期间是只读的，而且之后仍然只读**：点那个终端里的 **「接管输入」** 才能继续输入。
  你正在打字时模型发起的调用会被拒绝，不会插进你那半行命令里。
- **`read` 返回的是屏幕内容**：已经滚出去的内容取不回来；`vim`、`htop` 这类全屏程序返回的是它们的原始屏幕。
- **`run` 需要 POSIX 风格的 shell**（`sh`、`bash`、`zsh`）；`cmd.exe` 或 PowerShell 下请用 `input`。
- **忙碌中的终端绝不会被写入。** 如果提示符还没回来——另一个命令占着前台，正在流式输出回复的 `dsh` 就是这种情况——`run` 会等到期限后**拒绝输入**，什么都不发，正在跑的命令不受打扰。等它结束、在那个终端里自己输入，或者改用私有 shell。
- **长输出不会丢。** 构建与综合日志的结论在末尾，所以返回的是输出的**末尾部分**；完整内容会写入文件，
  结果里给出该文件的路径。

命令以**你的身份**运行，和你自己敲完全一样；在**协作调用**里每条命令在终端中都是**一行短而可读**的样子
（`__dsh_term_run 'make syn'`）——因为工具第一次在那个终端里跑命令时，会先定义好这个一行的包装函数。
拿回来的是两个标记之间的输出，外加退出码。**这个工具没有开关**：它一直在；带 `subtask` 的跑在私有 shell 里，
不带 `subtask` 的在**你开着的终端**里协作执行，显式点名 `id` 则按点名来。危险命令仍然要先过守卫（除非调用方
明确说明那是有意为之）。

它只在**需要同一个 shell 跨多步**时才值得用 —— 想看着它跑完的长构建、交互式程序、必须保留的目录或环境。
自洽的命令交给 `wsl` 更划算：每次全新 shell、可以并行、根本不需要终端，也不会把键盘从你手里拿走。

### `wsl-read`、`wsl-write`、`wsl-edit`

发行版里的文件在 Windows 侧可以通过 `\\wsl.localhost\<发行版>\...` 访问，但那是个 **9p 共享，写不进去**：
平台的读写工具靠"先写临时文件再改名"来保证原子性，而这个改名在 9p 上直接失败（`ENOTSUP`），
它之前那次 DACL 复制则报 `GetFileSecurityW EIO`。这个路径看起来像 Windows 路径，其实不是，
所以这三个工具改成**在发行版内部**完成同样的操作——走的是 `wsl` 用的同一个启动器，
没有第二套传输、不依赖 SMB，`/mnt/c/...` 上的文件一样能读写。

```
wsl-read({ path: '~/project/src/main.js' })                    → 整份文件
wsl-read({ path: '/var/log/syslog', offset: 200, limit: 40 })  → 第 200-239 行，返回时标明是这一段
wsl-write({ path: '~/notes/today.md', content: '…' })          → 自动建父目录，整文件替换
wsl-edit({ path: '~/app/config.json', oldString: '"port": 80', newString: '"port": 8080' })
                                                               → 唯一匹配才动手，否则拒绝
```

有几点要知道：

- **只处理文本，而且会明说。** 二进制文件、或不是合法 UTF-8 的文件会被**拒绝**并给出原因，而不是把乱码
  当内容返回。这类事情交给 `wsl`（`base64`、`od`、`cp`），它也是这三个工具覆盖不到时的出口。
- **写入是原子的，而且保留权限。** 内容先写进同目录的临时文件，再改名覆盖目标，所以写到一半中断也不会
  毁掉原文件；写之前会复制原文件的权限，`755` 的脚本改完还是 `755`。
- **`edit` 不是正则。** `oldString` 必须**恰好出现一次**（否则要用 `replaceAll: true`），
  `newString` 里的 `$&`、`$1` 和反引号都是字面文本。编辑会先读文件、核对自己拿到的字节数与 shell
  报告的大小是否一致——文件在读取途中被改动就是这样被发现的——确认无误后才写回。
- **这是便利，不是沙箱。** `wsl` 本来就能写你有权限写的任何文件，所以这三个工具没有增加新的能力；
  它们增加的是"模型不必自己拼 shell 命令"，以及"结果是有结构的，而不是靠解析屏幕"。
- **界面上，编辑和写入都是以 diff 呈现的。** `wsl-edit` 执行时，卡片先显示你要求的替换；结束时
  卡片被换成真正落盘的 hunk，上下各带三行上下文——与平台自带 `edit` 同一张卡片、同样的宽度。
  `wsl-write` 没有可比的旧内容，所以它的卡片全是新增行，这也正是平台自带 `write` 画的样子。
  历史里重放时用结果中存下的 hunk 重绘，不需要再读文件。模型读到的仍然是那一行摘要，不是 diff。
- **`asRoot` 是打开"你没有权限的文件"的那扇门。** 用户读不了的文件会被明确拒绝为 `permission
  denied`，而不是当成空文件返回；同一个调用加上 `asRoot: true`（并且面板里打开「管理员模式」）就以
  root 执行，把它读出来。以 root 编辑时会复制原文件的属主，所以改别人的文件不会把它悄悄变成 root 的。

### `wsl-grep`

在发行版里搜索文件内容，按文件分组返回带行号的匹配行——参数和结果形状都与平台自带的 `grep` 一致，
只是指向发行版而不是 Windows：

```
wsl-grep({ pattern: 'TODO', path: '~/project' })
wsl-grep({ pattern: 'listen\\(', path: '/etc/nginx', include: '*.conf' })
```

`pattern` 是正则，`path` 是 Linux 路径（默认当前会话的工作目录），`include` 是**一个**正向 glob
（`*.ts`、`*.{js,jsx}`），不是列表，也不支持取反——两个引擎都只接受单个过滤条件，传列表只会静默地
搜错文件。结果上限 250 条匹配、每条预览行 2000 字节；被截断时结果会说明一共看到多少条，需要上下文
就用 `wsl-read` 读那个文件。

引擎取决于发行版里装了什么：有 `rg` 就用 `rg`（尊重 `.gitignore`、跳过二进制、输出 JSON），否则退回
GNU `grep -E`——Ubuntu 镜像默认就是后者。这个差异在两处可见，写正则前值得知道：

- **方言。** `rg` 支持 `\d`、`\w`、`\b`，`grep -E` 不支持。用了这些的表达式在一个引擎上能搜到、
  在另一个上一条也搜不到，所以安全子集是两个都认的那部分。两个引擎都编译不了的表达式会被当作
  **搜索失败**报出来，而不是"没有匹配"。
- **忽略规则。** `rg` 会跳过 `.gitignore` 排除的文件，`grep` 不会，所以同一条搜索在两台机器上
  可能返回不同的文件集合。在意这个差异时，用 `wsl-bootstrap` 把 `ripgrep` 装上。

路径里带冒号正是回退方案要向 `grep` 要 `-Z` 的原因：文件名与行号之间用 NUL 分隔，`a:b.ts` 就还是
一个路径，而不会被拆成"文件 `a`、第 `b.ts` 行"。二进制文件不会出现在结果里——`grep -I` 与 `rg`
的默认行为都会跳过它们。

## 以 root 执行（`asRoot`）

WSL 的 root 不需要密码，因此可以让单次调用以 root 执行（即 `wsl -u root`）。它由面板里的一项开关把关
（「管理员模式（root）」，默认关）：

```
wsl({ command: 'apt-get install -y jq', description: 'install jq', asRoot: true })
```

授权来自开关而不是参数：开关关着时，`asRoot: true` 会被**明确拒绝并告知该打开哪个开关**，而不是悄悄降级成
你的普通用户。每次以 root 执行的结果都会标注（`[ran as root: wsl -u root]`）；危险命令守卫照旧叠加生效：
`rm -rf` 无论是否以 root 执行都仍需 `allowDangerous: true`。

四个文件工具接受同一个参数、遵守同一项开关——`wsl-read`、`wsl-write`、`wsl-edit`、`wsl-grep` 都支持
`asRoot`——所以"用户打不开的文件或目录"只差一个参数，不必再绕去写一条 `wsl` 命令：

```
wsl-read({ path: '/etc/ssl/private/site.key', asRoot: true })
wsl-grep({ pattern: 'PasswordAuthentication', path: '/etc/ssh', asRoot: true })
```

## 安装

发布到 npm 的包名是 **`dsh-wsl-tool`**，不是 `dsh-wsl`：registry 判定 `dsh-wsl` 与既有包
`is-wsl` 过于相似而拒绝，换 token 或改设置都无法绕过。仓库名、插件名与市场条目仍沿用
`dsh-wsl`。组合包的 patch 用相对路径指向自身入口，因此 `node_modules` 下的文件夹名可以
不同——必须一致的是你安装时使用的那个名字。

1. 将本包加入 DSH 的 profile（`profiles/<profile>/package.json`）：

   ```json
   { "dependencies": { "dsh-wsl-tool": "file:<path-to-this-repo>" } }
   ```

   或运行 `dsh plugin add --profile <profile> dsh-wsl-tool` 从 npm 安装，或用
   `dsh plugin add --profile <profile> file:<path-to-this-repo>` 从本地检出安装
   （依赖名会取本包自身的名字）。

2. 不必再做别的。本包的 `cordis.patch.yml` 会在组合包加载时**自己插入** `tool-wsl` 行
   （进程级），因此这些工具对所有 agent preset 都可用，无需额外接线。**不需要选择任何模式，
   也不要在 preset 里加任何东西**——左侧栏的 WSL 面板同样是这样出现的。

   **不要**再在 preset 里列一遍 `tool-wsl`：DSH 按名字注册工具，第二次注册会直接失败
   —— `tool "wsl" is already registered in this scope`。这一行只由组合包提供。

3. 重启 DSH。

设置面板是唯一可选的一块：它的表单需要 `@deepseek-ai/schemastery`，多数 profile 已经有了
（只要装过任何依赖它的插件；没有的话把它加进 profile 的依赖即可）。没有它时，工具与
面板里的「WSL 终端启动路径」照常可用，只是开关不显示 —— 面板会直接说明这一点，不会一直转圈等待。

## 兼容性

清单里声明了它需要的 DSH —— `"engines": { "dsh": ">=0.2.1-rc.2" }`。有两处会依据这条声明
行动：插件市场把它在条目上标成要求，并在装到更老的宿主上之前给出提醒；宿主自己的安装门禁也会
拒绝「声明的范围不含当前 DSH」的版本。**只支持 0.2.1 及更新版本**：旧代终端兼容层（DSH ≤0.2.0，
插件可以通过 `terminalController.follow`/`write` 直接驱动浏览器终端）已经删除，终端工具在这些
宿主上会明确报告「无法驱动终端」，而不是伸手进你的 shell。其余五个工具只是普通的 subprocess
调用，在老宿主上仍然能跑，但包本身不再作出那个支持承诺。

已在 DSH **0.2.1-rc.2** 上验证：工具 schema 通过 DSH 自己的 `assertSupportedJsonSchema`；
subprocess 接缝是跑在**真实 provider** 上而非替身；后台任务路径跑在**真实 job 注册表**上，
包含「会话 id 属主围栏」（0.2.1 的 job id 是 `kind-<16 hex>`，所以检查读注册表给的那个 id，
而不是假定形状）。这套检查就是 `test/real-seam.mjs`，约一分钟即可重验一个新宿主——升级后把它
指向新的 DSH 安装即可：

```sh
DSH_SUBPROCESS_LOCAL=/path/to/dsh/node_modules npm run test:real
```

后台任务由**调用方会话**持有（`owner: exec.agent.id`），这既是模型能用
`job_output`/`job_kill` 读回它的依据，也是其他会话读不到它的围栏；exec 里没有 agent 时
任务则是无主的。

终端工具有两条受支持的驱动路径：**浏览器桥**（0.2.1：由本插件的浏览器半加入你打开的侧边栏终端，
宿主把 `attach`/`write`/`detach` 经 `/dsh-wsl-tool/term-bridge/poll` 与 `/events` 交给页面，
页面用结果、屏幕快照与输出作答）和**私有 PTY**（工具自己的活用 `subprocess.spawnTerminal`
开一个自己的 shell——动作相同、输入框上方的记录相同，只是这个 shell 工具私有，你打开的终端不受影响）。
两条路径都有 `npm test` 覆盖。

## 左侧栏的 WSL 面板

插件带了一个小的客户端半：桌面版左侧栏里多一个 **WSL** 入口，面板里每个功能一个开关，每个开关
配一行说明。

| 开关 | 管什么 |
|---|---|
| `wsl` 命令执行 | 是否注册 `wsl` 工具 |
| `wsl-path` 路径转换 | 是否注册 `wsl-path` 工具 |
| `wsl-env` 能力体检 | 是否注册 `wsl-env` 工具 |
| `wsl-doctor` 项目体检 | 是否注册 `wsl-doctor`，**默认关**：诊断类工具按需开启 |
| `wsl-bootstrap` 安装工具链 | 是否注册 `wsl-bootstrap`，它可能往发行版里装东西。**默认关**，且每次调用还得显式关掉 `dryRun` |
| 后台任务 | `wsl` 是否接受 `runInBackground` |
| 自动转换路径 | 每次调用的 `translatePaths` 默认值 |
| 默认跟随会话工作区 | 未传 `workdir` 时从会话目录开始，而不是 `~`。**默认开**：关掉的话，agent 写的相对路径都会落进 Linux 家目录 —— 那儿在资源管理器里看不见，还会撑大 WSL 磁盘镜像 |
| Linux 默认工作目录 | 未传 `workdir` 时使用的固定 Linux 目录（如 `/mnt/d/project`）。填了就优先于上面的开关；清空则先看 `DSH_WSL_WORKDIR`，没设才回到跟随会话 |
| WSL 终端启动路径 | 可选的侧边栏终端从哪个目录启动 —— 写进你 **profile patch** 里 `terminal-controller` 那一行的 `--cd <目录>`（见[可选：在侧边栏开一个 WSL 终端](#可选在侧边栏开一个-wsl-终端)）。留空则删掉该参数；当前值也是从这个文件读的 |
| 终端历史行数 | 那个终端保留多少行输出（同一行上的 `scrollback`）。平台默认 1000；填 `0` 不保留，留空回到默认。这两项都在重启 DSH 后生效 |
| 危险命令守卫 | 危险命令是否必须显式 `allowDangerous` |
| 管理员模式（root） | `wsl` 与四个文件工具是否接受 `asRoot: true`（`wsl -u root`）。WSL 的 root 免密，所以这项开关就是授权本身；**默认关** |

面板改的是插件自己的配置，所以同样的值也可以手写进 profile patch（`- id: tool-wsl` 加 `config:`）
或用环境变量设。优先级由 `lib/config.js` 定：**插件配置 > 环境变量 > 内置默认值**；开关停在默认值时
下层说了算。所以从没打开过面板的人设 `DSH_WSL_WORKDIR` 依然生效——即使「跟随会话工作区」还停在默认的
开：环境变量是显式的部署决定，说话比开关的默认值响。

「WSL 终端启动路径」是唯一的例外：侧边栏终端属于另一个插件，所以那个输入框改的是你 profile 的
patch 层 —— 每次写入前先备份该文件，只重写终端那一行的 `args`，写后还会读回来核对，只要不是"只改了
这一行"就当场还原。

**改动在下次启动 DSH 后生效**：宿主每次挂载只读一次该配置，面板里也写着这句。发行版与超时属于"值"
而不是"功能"：在 patch 里或用 `DSH_WSL_DISTRO` / `DSH_WSL_TIMEOUT_MS` 设置，面板只显示当前生效值。

这个设置界面需要 `@deepseek-ai/schemastery`（插件把它声明为可选 peer 依赖）：没有它工具照常按
默认值工作，只是没有面板。

面板**最底部**是一个反馈入口，旁边跟着一段简短的提交指南，以及一个「复制插件信息」按钮（详见
[反馈](#反馈)）。按钮会向宿主半的 `/dsh-wsl-tool/info` 索取本插件自己的信息 —— 包名、版本、仓库
（都从 `package.json` 读出）、Node 与平台 —— 外加**它正运行在哪个 DSH 构建里**、以及 `wsl-env`
那一套 WSL 事实（默认发行版、内核、能力标记），然后连同当前生效的配置一起复制出来。
这些值没有一个是"发版时要记得手改"的字符串；探测失败时它写明失败，绝不编造。

## 可选：在侧边栏开一个 WSL 终端

桌面版侧边栏终端可以开 WSL 而不是 Windows shell。这是**可选**的 —— 装插件**不会**改你终端默认
开什么 —— 启用用的 patch 随包提供：[`extras/terminal-wsl.patch.yml`](extras/terminal-wsl.patch.yml)。

启用方式：把里面的条目复制进你自己 profile 的 patch 层
（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）；命令行启动也可以改成
`--patch <已安装文件路径>`。**下次启动应用时生效。**

这个启动目录也能在面板里设：顶部的「WSL 终端启动路径」（挨着「默认 Linux 工作目录」）会从那个
文件读出当前值，再把 `--cd <目录>` 写到该行 `args` 上 —— 写前先备份 patch 文件，只改这一行，
写后读回来核对。**清空**则删掉该参数，终端回到跟随会话工作区（启动时的 Windows 目录会被翻译成
`/mnt/…`）；填 `~` 固定到 Linux 家目录。改完同样**重启 DSH 生效**。

它旁边的「终端历史行数」在**同一行**上设置 `scrollback`：终端保留多少行输出，长构建才不会被滚掉
（平台默认 1000 行）。填 `0` 表示不保留，留空则回到默认。历史越长，应用与宿主两侧占用的内存越多，
所以这是一个由你决定的数字，而不是一个固定的大值。写入规则与生效时机（重启 DSH）都与上面一致。

```yaml
- id: terminal-controller
  config:
    shell:
      path: 'C:\Windows\System32\wsl.exe'
      name: WSL
      args: ['-e', 'bash', '-l']
```

- 「新建终端」的列表来自组合里的 `terminal-controller` 行：它把配置的 `shell` 排在最前，同时保留
  它发现的 `powershell`/`cmd`/`bash` 等可选。那个选择列表属于核心 UI，所以**按 id 覆盖该行**是
  受支持的入口 —— 这也是它没法做成普通插件条目的原因。
- **不锁定发行版**：`wsl.exe` 跟随系统默认，与工具在未设 `DSH_WSL_DISTRO` 时的规则一致。要锁定就
  在 `args` 里加 `-d <名字>`。
- 会话工作区是 Windows 路径，`wsl.exe` 会自动翻译，因此终端像 Windows shell 一样落在
  `/mnt/<盘>/…`；而且是**真 PTY**（`xterm-256color`），全屏程序可用。
- 按 id 的 patch 会**整段替换**该行 config，你之前在该行上设过的东西（终端上限、scrollback、
  自定义 `shellCandidates`）要一并重述。

## WSL 终端里的 `dsh` 命令

在 WSL 里可以直接对桌面版说话：

```sh
dsh "帮我把 nemu 的编译错误修掉"
```

这句话进入面板指定的 DSH 会话——客户端里看到同一条消息和同一段回复——终端这边
流式显示：先出现思考计时，回答逐字回来，结束时一行汇总（耗时、步数、
token）。按 `Ctrl+C` 只是停止等待，那一轮会在客户端里继续跑完。

终端就是这段对话的另一个入口：输入原样转发过去，客户端把回复流式转回——终端会显示思考计时，
但不显示思考内容。会话正在回答时，这行输入以 steer 方式送入当前回合，不排队、也不会丢。

| 命令 | 作用 |
|---|---|
| `dsh "问题"` | 发给当前会话，流式显示回复 |
| `dsh <id> "问题"` | 发给指定会话 |
| `dsh list` | 列出会话（最新在前，`*` 表示当前） |
| `dsh new <id>` | 新建会话（客户端里会出现）并切换过去 |
| `dsh use <id>` | 切换当前会话 |
| `dsh rm <id>` | 归档会话（客户端自己的可恢复删除） |
| `dsh status` | 当前会话与通道状态 |

终端里发来的消息在对话里带 **【WSL 终端】** 前缀，一眼就能和客户端输入区分；⏱ 思考计时会**持续跳动**，按「几分几秒」显示（`0分05秒`、`1分23秒`），不会停在第一个数字上。shim 每个通道实例只解析一次传输路径（以前每条命令都要探测被防火墙静默丢包的那条）；宿主接受请求后立刻显示**… 已送达，等待模型 Ns** 的实时计时，等待可见而不是像卡住。这段等待是模型的，不是通道的：同一台机器实测宿主 2–20 ms 就确认，shim 再加约 0.1 s；而一个回合在小会话上约 1.8 s，在带着约 18.2 万输入 token 的面板落点上要 4.8 s。回合结束后，终端会打印当前登录的 DeepSeek 账户余额（充值余额与赠金，按账户面板的格式）；未登录或暂时读不到会如实说明，不会显示成 `¥0.00`。余额是在模型工作时后台取的，不会拖慢回复。终端聊天嫌慢时，给它单独开一个精简会话（`dsh new terminal` 然后 `dsh use terminal`），别用那个很大的落点会话，或者先压缩它。不碰模型的子命令很便宜：`dsh use` 只改一个本地文件（约 15 ms，不碰通道），`dsh new`/`dsh rm` 一次往返，`dsh list` 直接返回缓存的会话行并后台刷新（通道启动后的第一次会完整重建）。需要联系宿主的命令约有 0.1 s 下限，那是 `curl.exe` 的进程启动时间：本机 WSL 自己的 curl 到 Windows 宿主网卡被丢包，所以 shim 有意使用 Windows 客户端。

发自终端的 `dsh "…"` 如果目标正是「正在执行这条命令的会话」，会被直接拒绝并说明原因：消息会加入那一轮，而那一轮要等命令返回——会自锁。这种场景等这一轮结束，或者在客户端里输入。只有插件的终端工具启动的 shell 才会带上调用方会话（`x-dsh-wsl-caller`），你自己在终端里输入不受影响。

回复流式输出期间终端没有提示符，但它仍然可以输入：**先按一次回车暂停输出**，敲完内容再回车就作为插入（steer）发进同一段对话，随后继续输出并显示 `已插入当前对话，继续输出`；第二次回车留空则取消插入。设 `DSH_WSL_NO_STEER=1` 可关掉这个输入；管道/脚本不会启用它，只有真终端才会。

终端发来的消息就**只是你敲的那句话**——屏幕内容不会出现在对话里。但你看到的画面仍然会到模型那里：宿主按命令行本身找到那条命令所在的侧边栏终端，只读地抓最近 100 行屏幕，作为**下一次模型请求的隐藏运行时上下文**（和「工作目录」、记忆插件用的是同一个 `systemPrompt` context 机制；只用一次、不写进对话）。还不够的话，模型可以用本插件自己的终端工具（`wsl-term read`，只读）再读同一个终端。识别是尽力而为且有上限的——没有打开的 DSH 窗口、找不到匹配终端、或读得太慢，就干脆不带，而且最多让回合晚开始约 3 秒。工具调用里发起的 prompt 不带上下文：那句话不是有人在终端里敲的。

在面板里设置一次：打开 **启用 dsh 命令**、点 **安装 dsh 命令**。默认落点是**最近活跃的会话**（通常就是你正在看的那段对话）；想换落点，在下拉里选中另一段会话（或当场新建）即可（脚本装到
`~/.local/bin/dsh`）。之后插件会自己维护它：每次启动（以及改设置）时读一次已安装的脚本，发现缺失或比当前版本旧就自动重装，不用再点按钮——这次检查只花一次 `cat`，通道关闭时和有回合在流式输出时都不碰 WSL；想关掉自动安装，把插件配置里的 `autoInstallShim` 设为 `false`。通道是插件绑在 WSL 默认网关地址上的一个小 HTTP 服务，随机端口，
每个请求都要带本次启动生成的令牌。桌面版需要在运行；指定的会话就是普通会话——通道
发进去的是一条普通用户消息（带「【WSL 终端】」前缀），所以客户端里看到的是同一段回复。

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
| `asRoot` | 否 | boolean | 本次调用以 root 执行（`wsl -u root`）；面板「管理员模式」关着时会被拒绝 |
| `translatePaths` | 否 | boolean | 默认 `true`；置 `false` 时 `command` 原样传入，不做路径改写 |

## 配置

面板里的开关与取值字段（`tools.wsl`、`tools.path`、`tools.env`、`tools.doctor`、
`tools.bootstrap`、`tools.read`、`tools.write`、`tools.edit`、`tools.grep`、`backgroundJobs`、
`translatePaths`、`startInSessionWorkspace`、`workdir`、`dangerGuard`、`allowRoot`、
`distro`、`timeoutMs`）都写在 profile patch 里，各自行上有说明。
其中两项**故意没有环境变量**：`dangerGuard`（它的关闭位置本身就是风险）与 `allowRoot`
（WSL 的 root 免密，所以那项开关就是授权本身）。环境变量这一层：

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_WSL_DISTRO` | （系统默认） | 为所有调用固定发行版 |
| `DSH_WSL_TIMEOUT_MS` | `600000` | 模型命令的默认超时；单次调用可用 `timeoutMs` 覆盖 |
| `DSH_WSL_MAX_TIMEOUT_MS` | `86400000` | 单次 `timeoutMs` 的上限，对齐平台 shell 工具的 `maxTimeoutMs`；默认超时也受它约束 |
| `DSH_WSL_MAX_OUTPUT_BYTES` | `65536` | 每条流的内存窗口（1 KiB – 8 MiB）；设到 64 MiB 以上时也会抬高落盘上限 |
| `DSH_WSL_WORKDIR` | （未设：交给开关） | 不传 `workdir` 时的起点：`home`（Linux 的 `~`）、`session`（会话工作目录，Windows 检出对应 `/mnt/<盘>/...`），或任意显式路径（Windows 路径同样会被转换）。显式设置时优先于「跟随会话工作区」的默认开；不设时由开关决定 |

无法解析或越界的值会回退到默认值——一个写错的环境变量不该让所有工具一起挂掉。
**改动即时生效**（包括工具开关）：注册工具时会拿到它自己的 disposer，所以每次设置更新都会把期望的工具集
与已注册的工具集做差分，开关一拨工具就出现或消失，不需要重启——这一点重要，因为开关就是在面板里拨的。
唯一例外是「WSL 终端启动路径」：它改的是别的插件在 profile patch 里的启动参数，那个插件在启动时读，
所以那一项要重启 DSH。

## 注意事项

- 每次调用都在全新的 shell 中执行——cwd / 变量 / 函数不会在调用间保留。
- **stdin 默认是 `/dev/null`，除非传 `stdin`**：交互式命令（`read`、`cat`、不带 `-S`
  的 `sudo` 密码提示）否则会立刻收到 EOF，无法等待输入；本插件不会、也无法弹出任何提示。
  通过 `stdin` 传的密码会被记进会话记录。
- 什么都不配时从会话工作目录开始（「跟随会话工作区」默认开）；要落到 `~` 就设
  `DSH_WSL_WORKDIR=home`，也可显式写 `session` 或固定路径（见“配置”）。
- 发行版取调用参数 → `DSH_WSL_DISTRO` → 系统默认，代码里不再硬编码兜底名称。
- 发行版不存在时会给出明确报错（`distribution "X" is not registered`），而不是
  一个原始 `-1` 退出码；其他启动器错误（`Wsl/Service/WSL_E_*`）也会带错误码上报，
  不会被当成命令自身的退出状态。
- **后台任务可以活得比这次调用久**：`runInBackground: true` 立即返回任务 id（`wsl-N`）
  并把工作登记进宿主任务注册表，`job_output` 读它（标记与前台一致）、`job_kill` 停它。
  后台模式下 10 分钟默认超时**不适用**，但显式 `timeoutMs` 仍然生效；非零退出与前台一样
  报成 `completed` 并把退出码写进 detail。
- `command`、`workdir` 以及配置/`DSH_WSL_WORKDIR` 给出的默认目录中的 Windows 路径会自动转换为 `/mnt/...`：
  - `C:\Users\me\a.txt` → `/mnt/c/Users/me/a.txt`；含空格、括号的路径与一行多个路径都支持
    （`C:\Program Files\Git`、`C:/Program Files/Git`、`C:\Program Files (x86)\Steam`、
    `cp C:\a.txt D:\b.txt` 两个路径都会转换）；
  - `\\wsl.localhost\<发行版>\home\x` 与 `\\wsl$\<发行版>\home\x` → `/home/x`；指向**别的发行版**的
    UNC 路径保持原样（否则 `/home/x` 会变成当前发行版的目录，读错东西）；
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
  shell 工具一致的会话事实。这些值**按次**从宿主的 `shellEnv` 注册表解析（与其他 shell 工具同一个来源），
  因为它们属于会话而非宿主常量——直接读宿主 `process.env` 会什么都读不到、静默地什么都不转发。
  **`DSH_WEB_URL` 故意不转发**——它是 Windows 侧服务的 `127.0.0.1` 地址，
  而默认 NAT 模式下 WSL 访问不到 Windows 回环（实测 `127.0.0.1` 与主机 IP 均返回 HTTP 000，服务本身
  也只绑回环），转进去只会给一个打不开的 URL。显式传入的 `env` 条目总是覆盖转发值。
- `wsl-env` 还会报出**会话文件所在的位置**以及它是否落在 Windows 盘挂载上：

  ```
  workspace: /mnt/d/DSHworkarea (Windows drive mount /mnt/d — builds, installs and git are much slower here; prefer a path under /home when it matters)
  ```

  这个提示值得当真。作者机器实测：128 MB 顺序写在 ext4 上约 **2.1 GB/s**，在 `/mnt/d` 上约
  **247 MB/s**；创建 400 个小文件 ext4 **不到 10 ms**，`/mnt/d` 要 **0.72 s**
  （后来复测：**885 vs 116 MB/s**、**13 ms vs 745 ms**，比值稳定在约 8× 与 50×）。

  不只是慢。`/mnt/<盘>` 是 9p（drvfs）挂载，保留的是 **Windows** 的文件系统语义：
  `chmod`/`chown` 不生效（`chmod 600` 读回来是 `777`）、文件名**大小写不敏感**（大小写写错只在
  Linux CI 上才炸）、符号链接与可执行位是合成的，而且 **inotify 完全不工作**——发行版里的 watcher
  对两侧写入都收不到任何事件（用 inotify 探针实测：`/mnt/d` 上 Windows 侧写入与 Linux 侧写入均为
  **0 事件**，而同一探针在 ext4 上正常报出创建/修改/关闭写入）。因此 dev server、`--watch` 模式
  与文件监听的测试在 Windows 盘上都是瞎的。需要时把项目放到 `/home` 下：语义、监听事件与上面那档
  速度一次性都回来。
- 危险命令默认被拒绝，除非调用时传 `allowDangerous: true`：
  - **任何递归删除**——`rm -r`、`rm -rf`、`rm -r -f`、`rm -R --force`、`rm --recursive`——
    因为 stdin 指向 `/dev/null` 时不会产生任何提示，`rm -r tree` 会静默删除整棵树。
    每次 `rm` 调用按其所在命令段单独判定，所以 `rm a -f; rm b -r` 不能靠拼接标志蒙过去；
    而作为**参数**出现的 `rm` 只是提及、不是调用，所以 `npm rm -r foo`、`ls rm -r` 照常放行；
  - 往块设备 `dd`、`mkfs`/`mke2fs`、分区/擦除类工具（`fdisk`、`parted`、`wipefs`、`mkswap` …）、
    对准设备的 `truncate`、`find … -delete`、会真删文件的 `git clean`、
    电源控制（`shutdown`、`reboot`、`systemctl reboot` …）、重定向到块设备（SATA/NVMe/virtio、
    `md`、`dm-*`、LVM 的 `mapper`）、fork 炸弹；
  - 防护会读包装器自己的选项**取值**和 shell 的 `-c` 脚本，所以
    `sudo -u root mkfs.ext4 …`、`nice -n 19 reboot`、`timeout 5 reboot`、
    `xargs -I{} poweroff`、`sh -c "reboot"` 都按它们真正执行的命令判定；
    设备/电源类工具只在**命令位置**匹配，因此查看它们是允许的：`man fdisk`、
    `grep -rn reboot /var/log/syslog`、`echo "the mkfs tool formats disks"` 都能正常执行——
    而引号里只是提到 `rm` 也不算调用（`grep -rn "rm -rf" docs/`、`git commit -m "fix rm -r"`）。
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
名称安装，例如 `dsh plugin add dsh-wsl-tool`，市场（storefront）也会提供一键安装。
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
| `lib/tools/*.js` | 工具定义（schema / execute / presentCall） |
| `lib/doctor.js` | `wsl-doctor` 的项目探针：一段 shell、它的解析器与报告组装 |
| `lib/bootstrap.js` | `wsl-bootstrap` 的配方、计划生成与结果渲染 |
| `lib/terminal.js` | `wsl-term` 背后的文本与选择逻辑：去转义、命令标记、终端选择 |

- `apply()` 解析配置并注册被启用的工具，每个都有 JSON-schema 参数定义、输出 schema、
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

插件不发布任何自身服务，且由它自己的组合包 patch **进程级**插入，因此既不需要 realm，
也不需要任何 preset 条目。

## 开发

插件是纯 ESM，无构建步骤，除 DSH 宿主平面外无运行时依赖。迭代方式：把 profile
依赖指向本仓库：

```json
{ "dependencies": { "dsh-wsl-tool": "file:/path/to/dsh-wsl" } }
```

然后重启 DSH，在**任意**会话里调用工具即可：组合包 patch 是进程级注册的，没有哪个 preset
需要声明这一行。

### 测试

```sh
npm test          # 1339 项宿主检查（跑在真实 WSL 上，仅用 shim 顶替 ctx.subprocess）+ 301 项客户端检查
npm run test:real # 同一套检查改跑真实 provider，外加 seam 事实套件
```

`npm test` 只替换 `ctx.subprocess`，用一个复刻了 seam 行为（有界尾窗、落盘文件、
终止阶梯）的 shim 驱动这些工具跑在真实 WSL 上，覆盖路径改写、workdir 引号处理、
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
npm run sync                  # 复制到 ~/.dsh/profiles/desktop/node_modules/dsh-wsl
npm run sync -- /path/to/profiles/<profile>/node_modules/<你的依赖名>
```

目标目录必须是 profile 依赖名对应的文件夹（上面的默认值就是本检出的依赖名）；
插件按相对路径加载自身入口，因此文件夹叫什么并不影响加载。

然后重启 DSH——插件在加载时只导入一次。

发版流程（tag 触发的流水线、npm 包名与目录条目）见 [`PUBLISHING.md`](PUBLISHING.md)。

## 收录

本仓库带有 `dsh-plugin` topic，并已提交至 awesome-dsh-plugin 社区列表的 `wsl` 分类。

## 反馈

侧边栏面板最后一段就是反馈入口，它**不会自己发送任何东西**。

- **缺陷或明确的需求** → [开一个 Issue](https://github.com/XINY11451/dsh-wsl/issues/new/choose)。
  模板会问一次环境，这决定了报告能不能被复现、要不要多来回一轮。
- **用法问题与想法** → [Discussions](https://github.com/XINY11451/dsh-wsl/discussions)。
- **GitHub 打不开？** 面板里的「复制插件信息」按钮会向宿主半索取这个包自己的信息 ——
  包名、版本、仓库（直接读 `package.json`），加上 Node、平台与当前生效的配置 ——
  连同面板正显示着的开关状态一起复制出来。粘进 Issue 的「补充」栏即可，只剩正文要自己写。
  提交指南就在按钮旁边，也在面板里。

那段文本在发出去之前你都能看清、都能改：不采集路径、主机名或任何凭据，插件也不对外发起请求 ——
按钮读的那个路由由本机宿主提供，不走网络。
属于别处的问题请发到各自的仓库 —— DSH 本体 →
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/issues)，市场界面 →
[dsh-market](https://github.com/dsh-market/dsh-market/issues)，收录与目录 →
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues)。
完整分流表见 [SUPPORT.md](SUPPORT.md)。
