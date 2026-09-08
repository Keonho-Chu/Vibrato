<p align="right">
  <a href="README.md">English</a> | <a href="README.ko.md">한국어</a> | <strong>中文</strong> | <a href="README.ja.md">日本語</a>
</p>


<h1 align="center">Vibrato</h1>

<p align="center">
  <sub>面向本地 LLM 端点、Claude 以及 OpenAI Codex 的终端编码代理。</sub>
</p>

<p align="center">
  <a href="https://github.com/Keonho-Chu/Vibrato"><img alt="Repository" src="https://img.shields.io/badge/github-Keonho--Chu%2FVibrato-002F6D?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/vibrato-cli"><img alt="npm package" src="https://img.shields.io/npm/v/vibrato-cli?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

> 本文档是英文 [README.md](README.md) 的翻译。如有出入，以英文版为准。

## 安装

**独立二进制文件** (推荐，无需 Bun)，支持 Linux (x64/arm64)、macOS (arm64/x64) 和 Windows (x64):

```sh
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.17.2/scripts/install.sh -o vib-install.sh
sh vib-install.sh
vib --version
```

Windows (PowerShell，请在普通终端中运行，而不是"以管理员身份运行"):

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/Keonho-Chu/Vibrato/v0.17.2/scripts/install.ps1 -OutFile vib-install.ps1
powershell -File vib-install.ps1
```

Vibrato 把会话保存在 `%USERPROFILE%\.vib` 下，而在提升权限的终端里创建的目录归 Administrators 组所有，而不是归你所有。Vibrato 会在启动时把它收回来，但从普通终端运行可以省掉这一步。详情以及 Git Bash 要求见 [Windows notes](docs/install.md#windows-notes)。

**使用 Bun 安装** (PATH 中需要已有 Bun 1.4 或更高版本；`bun install -g` 不会替你安装 Bun):

```sh
bun install -g vibrato-cli
vib --version
```

其他安装方式:

```sh
# 始终使用最新安装脚本 (执行 main 分支上的可变内容)
curl -fsSL https://raw.githubusercontent.com/Keonho-Chu/Vibrato/main/scripts/install.sh | sh

# 就地更新现有安装
vib update
```

完整平台列表、nightly 渠道、Shell 补全和源码构建: [docs/install.md](docs/install.md)。

## 首次运行

在任意 git 检出目录中运行 `vib`。首次启动且没有可用模型时，Vibrato 会直接打开一个连接屏幕，按 Esc 可跳转到完整的提供商菜单。随时可用 `/provider` 打开同一屏幕。

- **本地 LLM 端点** (vLLM、SGLang、Ollama、LM Studio、llama.cpp，或任何其他兼容 OpenAI 的服务器): LLM 服务器通常是网络中的另一台机器，例如局域网里的 GPU 主机，输入它的地址并连接即可。`192.168.0.10:8000` 或 `gpu-server.lan:8000` 这样的简写就够了，Vibrato 会自动补上协议和 `/v1` 路径：私有网络地址以及 `.local` / `.internal` / `.lan` 地址推断为明文 `http://`，其他地址推断为 `https://`。这只是默认值——自己写上协议就会按原样使用，因此如果公司网络在其他地址段上用明文 http 提供 GPU 服务器，写成 `http://172.170.0.52:8000` 即可。不再需要单独的 API 密钥步骤：Vibrato 会先探测端点，只有当服务器返回 401 或 403 时才会显示密钥输入框。作为一个附带的便利功能，如果本机上已经有兼容服务器运行在常见回环端口(Ollama、llama.cpp、LM Studio、oMLX、vLLM、SGLang)，也会作为可选择的一行出现在同一屏幕上。连接后，从服务器报告的模型中选择；如果只发现一个模型，会自动选中它。
- **Claude** 或 **OpenAI Codex** (订阅计划，作为本地端点的替代方案): 运行 `/login`，选择 `anthropic`、`openai-codex` (浏览器) 或 `openai-codex-device` (无头模式)。

在 Shell 中完成同样的设置:

```sh
vib setup provider --preset local --base-url http://192.168.0.10:8000/v1   # 例如局域网中的 GPU 主机；密钥来自 LOCAL_LLM_API_KEY (如有)
```

`vllm` 和 `sglang` 预设仍然保留，供已经使用它们的脚本和 CI 继续使用:

```sh
vib setup provider --preset vllm --base-url http://192.168.0.10:8000/v1    # 密钥来自 VLLM_API_KEY (如有)
vib setup provider --preset sglang --base-url http://192.168.0.10:30000/v1 # 密钥来自 SGLANG_API_KEY (如有)
```

显式写出的 `http://` 或 `https://` 对任何主机都按原样使用。只有裸的 `host:port` 才会推断协议：localhost、私有网络主机、裸主机名以及 `.local` / `.internal` / `.lan` 名称为明文 `http://`，其他为 `https://`。

## 使用

```sh
vib                                        # 在当前检出目录中启动交互会话
vib "列出 src/ 下所有 .ts 文件"              # 带初始提示的交互会话
vib @prompt.md @screenshot.png "解释一下"    # 用 @ 附加文件或图片
vib -p "总结这个仓库"                        # 非交互: 输出答案后退出
vib --continue                             # 继续上一个会话
vib --resume                               # 选择更早的会话
vib --worktree my-task                     # 在隔离的 git worktree 中工作
vib --tmux                                 # 在 tmux 会话中运行
vib --model opus "重构这个模块"               # 按模糊名称选择模型
vib --list-models                          # 显示可用模型
```

会话内命令:

| 命令 | 作用 |
| :--- | :--- |
| `/provider` | 打开连接屏幕 (本地 LLM 端点，OpenAI Codex/Claude 作为替代方案) |
| `/login` | 登录 Claude 或 OpenAI Codex |
| `/model` | 切换当前模型 |
| `/theme` | 切换 TUI 主题 |
| `/skill:deep-interview` | 规划前澄清模糊需求 |
| `/skill:ralplan` | 修改文件前制定并评审计划 |
| `/help` | 列出所有斜杠命令 |

常用 CLI 命令:

```sh
vib --help                  # 所有参数
vib setup --help            # 提供商与凭据设置
vib customize doctor        # 诊断工具、技能、钩子或 MCP 服务器为何未加载
vib config set <key> <val>  # 在 Shell 中修改设置
vib update                  # 更新到最新版本
```

深色终端的默认 TUI 主题是应用 LIG System 企业识别的 `lig-blue`，浅色终端默认使用内置的 `lig-white`。显式的主题设置始终优先。

## 文档

- [安装、更新渠道、平台说明](docs/install.md)
- [模型、提供商与认证](docs/models.md)
- [自定义提供商与多账户路由](docs/custom-providers-and-multi-account.md)
- [技能](docs/skills.md)
- [设计系统](docs/design-system.md)
- [外部控制器 / 机器人集成](docs/bot-integration.md): 通过 Telegram、Discord、Slack 或自建机器人驱动 Vibrato
- [外部控制就绪度](docs/external-control-readiness.md)
- [Aside 搜索/上下文边车](docs/aside-integration.md)
- [代码库概览](docs/codebase-overview.md) 以及 [docs/](docs/) 中的其他文档

## 许可证

MIT。参见 [LICENSE](LICENSE)。历史署名见 [NOTICE.md](NOTICE.md)。
