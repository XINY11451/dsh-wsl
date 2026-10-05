# 支持与反馈 / Support and feedback

这个插件只有一个维护者，所以"发对地方"能省掉一轮来回。
This plugin has one maintainer, so getting the report to the right place saves a round trip.

## 去哪儿反馈什么 / Where to report what

| 你遇到的问题 / What you hit | 发到哪儿 / Where |
|---|---|
| **插件的 bug**：命令失败、路径转换不对、面板开关无效、后台任务异常… / A **plugin** bug | **[本仓库的 Issue](https://github.com/XINY11451/dsh-wsl/issues/new/choose)**（有模板，会问你环境）/ **Issues here** (templates ask for the environment) |
| **功能建议**：想要一个新能力 / A **feature request** | **[本仓库的 Issue](https://github.com/XINY11451/dsh-wsl/issues/new/choose)**，选「功能建议」模板 / Issues here, the feature template |
| **用法问题、想法、经验分享** / Usage questions, ideas, war stories | **[Discussions](https://github.com/XINY11451/dsh-wsl/discussions)** |
| **DSH 本体的问题**（与 WSL 无关的界面、会话、模型…）/ **DSH itself** | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/issues) |
| **插件市场的界面问题**（浏览、安装按钮、列表渲染…）/ The **market UI** | [dsh-market](https://github.com/dsh-market/dsh-market/issues) |
| **收录/目录问题**（列表文案、分类、截图没更新…）/ The **catalog listing** | [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/issues) —— 注意：那里的 Issue 只处理列表与站点本身，插件 bug 发过去会被关掉 / Note: Issues there cover the list and its site only; plugin bugs are closed |

## 提交 bug 前，先把这几件事准备好 / Before filing a bug

1. **插件版本** —— 面板底部的「复制插件信息」会替你读出来（来自 `package.json`），或 `npm ls dsh-wsl-tool` / The plugin version, read out by 「复制插件信息」 in the panel (from `package.json`), or `npm ls dsh-wsl-tool`
2. **DSH 版本** —— 同一个按钮也会读出来（从应用自己的 manifest），设置里也能看到 / The same button reads it out (from the application's own manifest); Settings shows it too
3. **WSL 发行版与内核** —— 同一个按钮会替你探测（默认发行版、内核、systemd/docker/GPU 等能力标记）；也可用 `wsl -l -v` 或 `wsl-env` 工具 / The same button probes them (default distribution, kernel, capability flags such as systemd, docker and GPU); `wsl -l -v` or one `wsl-env` call work too
4. **原文**：完整命令、完整报错、界面上出现的话 —— 不要转述 / The exact command, the exact error, the exact UI text — not a paraphrase

侧边栏面板底部是**一个**反馈入口：旁边写着提交指南（标题怎么起、正文写哪三段、粘到哪个字段），以及一个「复制插件信息」按钮。点它会由宿主半**自动读取**：包名、版本、仓库（来自本包的 `package.json`）、Node 与平台、它正运行在哪个 DSH 构建里、以及 WSL 的默认发行版/内核/能力标记 —— 再配上当前生效的配置和各开关状态，一次复制完。粘进 Issue 的「补充」栏即可。读取要跑几次 WSL 探测，所以按钮会先显示「正在读取…」；读不到的项会写明"未能读取"，不会编造。它**不会**自己发送任何东西。
The panel ends with **one** feedback entry: a submission guide beside it (how to title it, which three paragraphs the body needs, which field to paste into) and a 「复制插件信息」 button. The host half **reads it all in**: package name, version and repository (from this package's `package.json`), Node and the platform, the DSH build it is running inside, and WSL's default distribution, kernel and capability flags — plus the effective configuration and the switch states. Paste that into the issue's 「补充」 field. A few WSL probes run first, so the button reads 「正在读取…」; anything unreadable says so instead of guessing. It sends nothing by itself.

## 关于隐私 / Privacy

- 插件**不做任何静默上报**：不点反馈入口，就不会有网络请求。/ The plugin reports nothing by itself — no request happens unless you open the feedback entry.
- 面板复制出来的文本只含**版本号、包名、仓库、Node 与平台、发行版名、超时，以及你面板里各开关的状态**；不含完整路径、主机名、用户名或任何凭据。/ The copied block contains versions, the package name, the repository, Node and the platform, the distribution name, the timeout and your switch states — no full paths, host names, user names or credentials.
- Issue 是**公开**的。提交前请自己过一眼，把不想公开的删掉。/ Issues are **public**. Read it once before submitting and delete what you would rather not publish.

## 修复的节奏 / How fixes happen

报告 → 复现（必要时我会请你补 `wsl-env` 输出）→ 改代码 → 测试（这个插件有 347 项宿主检查 + 76 项客户端检查）→ 发版（npm + 市场资产同一次发布，逐字节一致）→ 你升级后回帖确认 → 关闭。
Report → reproduce (I may ask for a full `wsl-env`) → fix → tests (the plugin ships with 347 host checks and 76 client checks) → release (npm and the market asset go out byte-identical in one run) → you confirm after upgrading → close.
