<p align="center">
  <img src="assets/brand/repository-hero.jpg" alt="Command Code Go 2 DeepSeek API" width="100%">
</p>

<h1 align="center">Command Code Go 2 DeepSeek API</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
  <a href="#配置"><img src="https://img.shields.io/badge/Windows-10%2B%2011-0078D4?logo=windows&logoColor=white" alt="Windows 10/11"></a>
  <a href="#配置"><img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodejs&logoColor=white" alt="Node.js 18+"></a>
  <a href="#配置"><img src="https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?logo=powershell&logoColor=white" alt="PowerShell 5.1+"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#接口">接口</a> ·
  <a href="#客户端">客户端</a> ·
  <a href="#与官方文档的差异">与官方文档的差异</a> ·
  <a href="#额度面板">额度面板</a> ·
  <a href="#配置">配置</a> ·
  <a href="#安全">安全</a> ·
  <a href="#故障排查">故障排查</a>
</p>

把 [DeepSeek 官方 API](https://api-docs.deepseek.com/zh-cn/) 的三套协议搬到本地，后端是 Command Code Go 套餐：改一个 `base_url` 就能用，行为按官方文档逐项实测对齐。

## 为什么这么做

Command Code 的 Go 套餐是 **$1 / 月**，官方原话是「Your $1 buys $10 of credits」，即 $1 换 $10 额度，十倍杠杆。这些额度按美元计价消耗在模型调用上，可以全部用在 DeepSeek 上：

| 窗口 | 上限 |
|---|---|
| 5 小时 | $3 |
| 每周 | $6 |
| 每月 | $10 |

对照 DeepSeek 官方 API 的定价（[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)），Flash 模型百万 token 输入缓存命中 ¥0.02、未命中 ¥1、输出 ¥4（空闲时段；高峰翻倍）。换算下来，$10 额度大致对应**千万级 token 的月用量**，而同样的量在官方 API 需要实付 $10。

也就是说：**花 $1 拿到官方 $10 的 DeepSeek 用量**，代价是走 Command Code 的通道、受套餐窗口限速，而不是直连 DeepSeek 的机房。

Go 套餐本身只对官方 CLI 开放 `/alpha/generate`，不提供标准 API。本项目补上协议翻译层，让这 $1 的额度能被任何 OpenAI / Anthropic / Responses 兼容的客户端调用——包括 Claude Code、Codex、opencode、pi、DSH。

这不是官方渠道，用量上限、模型可用范围、服务稳定性都取决于 Command Code 而非 DeepSeek，也可能随时变化。它适合个人开发与试验，不适合当作生产依赖。

## 快速开始

需要 Windows 10/11、PowerShell 5.1+、Node.js 18+。

```powershell
.\scripts\install.ps1      # 装依赖、生成 config.json、应用协议补丁
commandcode login          # 登录 CLI，生成 auth.json
.\launch.ps1               # 启动；窗口开着就在跑，关窗即停
```

启动后面板会列出三个本地地址。可选：

```powershell
.\scripts\make-shortcut.ps1   # 桌面快捷方式
.\scripts\test-proxy.ps1      # 自检
npm run verify                # 三套协议对齐验证
```

## 接口

| 协议 | 本地地址 | 官方文档 |
|---|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8787/v1` | [create-chat-completion](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion) |
| Anthropic Messages | `http://127.0.0.1:8787` | [anthropic_api](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) |
| Responses | `http://127.0.0.1:8788/v1` | [responses_api](https://api-docs.deepseek.com/zh-cn/guides/responses_api) |

API Key 填 `proxy-managed`（哨兵值，代理替换成 `auth.json` 里的真实密钥）。填别的值会被当作你自己的密钥转发上游，返回 401。

模型名用 `deepseek-v4-flash`（也可写 `deepseek-flash`，官方推荐名）。`/v1/models` 会列出全部可用模型及上下文窗口。

## 客户端

官方为 8 个 Agent 提供了接入指南。本项目不重写这些配置——按官方文档配好，
只把 base URL 换成本地地址即可，协议行为一致。

| Agent | 官方接入文档 | 本地要改的 |
|---|---|---|
| Claude Code | [claude_code](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code) | `ANTHROPIC_BASE_URL` → `http://127.0.0.1:8787` |
| Codex | [codex](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex) | `base_url` → `http://127.0.0.1:8788/v1` |
| OpenCode | [opencode](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/opencode) | `baseURL` → `http://127.0.0.1:8787/v1` |
| Hermes | [hermes](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/hermes) | Base URL → `http://127.0.0.1:8787/v1` |
| OpenClaw | [openclaw](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/openclaw) | Base URL → `http://127.0.0.1:8787/v1` |
| Qoder | [qoder](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/qoder) | 自定义模型的 Base URL → `http://127.0.0.1:8787/v1` |
| Reasonix | [reasonix](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/reasonix) | 首次向导里的 Base URL → `http://127.0.0.1:8787/v1` |
| WorkBuddy / CodeBuddy | [workbuddy](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/workbuddy) | `models.json` 里的 `url` → `http://127.0.0.1:8787/v1/chat/completions` |

API Key 一律填 `proxy-managed`。

### 用 CC Switch 一键切换

[CC Switch](https://github.com/farion1231/cc-switch) 支持 10 个客户端，其中 8 个走
DeepSeek 预设时可以直接指向本地。复制对应的 DeepSeek 预设，只改地址：

| CC Switch 里的客户端 | 改哪个字段 | 值 |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` |
| Claude Desktop | 模型映射的 Base URL | `http://127.0.0.1:8787` |
| Codex | TOML 的 `base_url` | `http://127.0.0.1:8788/v1` |
| OpenCode | `options.baseURL` | `http://127.0.0.1:8787/v1` |
| OpenClaw | 供应商 Base URL | `http://127.0.0.1:8787/v1` |
| Hermes | `base_url` | `http://127.0.0.1:8787/v1` |
| Pi | `baseUrl` | `http://127.0.0.1:8787/v1` |
| MiniMax Code | 模型配置的 Base URL | `http://127.0.0.1:8787/v1` |

Gemini CLI 与 Grok Build 走各自的 Native 协议，本项目未实现，不能指向本地。

### 三个会踩的坑

**Claude Code 的上下文声明**：它按内置模型目录判断窗口，遇到没见过的模型名会退回 200k 并告警。
在模型名后加 `[1M]` 声明真实窗口即可，这个后缀不会发给上游：

```powershell
$env:ANTHROPIC_MODEL = "deepseek-v4-flash[1M]"
```

也可以用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`。

**OpenCode 的模型 id 不能带斜杠**：它用 `provider/model` 寻址，斜杠会被当层级分隔符，
把 `deepseek-v4-flash` 之外的写法（如带 `/` 的）写进 `models` 会被截断导致 403。
用扁平的 `deepseek-v4-flash`，调用时 `--model ccgo/deepseek-v4-flash`。

**pi / DeepSeek Harness 按 URL 判断供应商**：两者底层同为 pi-ai，会看 base URL 里有没有
`deepseek.com` 来决定思考格式。本地地址不含该串，需显式声明 `compat`：

```json
{
  "compat": {
    "thinkingFormat": "deepseek",
    "requiresReasoningContentOnAssistantMessages": true,
    "requiresThinkingAsText": false,
    "maxTokensField": "max_tokens",
    "supportsReasoningEffort": true
  }
}
```

pi 的配置放 `$env:PI_CODING_AGENT_DIR\models.json`。
## 与官方文档的差异

三套协议逐项实测，`npm run verify` 可复现：

```
PASS  OpenAI Chat Completions  差异 0
PASS  Anthropic Messages       差异 0
PASS  Responses                差异 0
```

需要知道的偏差，全部源于上游通道的能力边界：

| 项 | 说明 |
|---|---|
| 计费 | 套餐窗口额度（$3 / $6 / $10），非官方按 token 计费 |
| `logprobs` / `top_logprobs` | 上游不返回，响应中为空 |
| `n > 1` | 只返回 1 条 |
| `web_search` 工具 | 上游无服务端搜索，忽略 |
| Files API | 无文件存储，未实现 |
| FIM 补全（`/beta`） | 上游无该端点，未实现 |
| 上下文硬盘缓存 | 由上游内部管理，不可控 |

官方本身标注为「忽略」的字段，本项目同样忽略、不报错。这类字段在各协议官方文档的兼容性小节里都有列表，实现时逐条对齐，未额外增减。

## 额度面板

<p align="center">
  <img src="assets/brand/panel.jpg" alt="额度面板：连接地址、模型清单与实测 TPS、三窗口额度" width="88%">
</p>

启动后显示静态面板，不自动刷新。测速**不自动执行**——TPS 栏启动时为 `-`，按 `T` 才测，因为每次测速都消耗额度。

| 按键 | 作用 |
|---|---|
| `R` | 刷新额度与实际用量 |
| `T` | 测速（消耗少量额度） |
| `Q` | 退出并停止 |

面板分四块：三套协议的本地地址、模型清单（上下文 + 实测 TPS）、三窗口额度（已用 / 剩余 / 进度 / 重置时间）、运行状态。TPS 达到阈值标绿、偏低标黄；`E` 表示测速失败。

数据来源：模型清单与上下文来自上游 `/provider/v1/models`，窗口上限与已用量来自 `/alpha/billing/credits`（上限由服务端下发，不写死），套餐名与月总额按 `planId` 映射。

## 配置

`config.json`（由 `config.example.json` 复制，已加入 `.gitignore`）。

| 字段 | 说明 |
|---|---|
| `Port` / `HostAddress` | 主代理监听，默认 `8787` / 仅回环 |
| `Responses.Enabled` / `Port` | Responses 适配层，默认开启、`8788` |
| `AuthFile` | 凭据路径，支持环境变量 |
| `Upstream.*` | 上游接口，换服务时改这里 |
| `Panel.ModelFilter` | 模型过滤正则，默认只匹配 DeepSeek |
| `Panel.SpeedTestModels` | 测速范围，留空表示全部 |
| `PlanCredits` | 各套餐月额度总额（服务端不下发此项） |

## 安全

默认只监听 `127.0.0.1`，不要改成 `0.0.0.0`。不要共享密钥——上游按密钥绑定设备指纹，多机并发最容易触发风控。凭据只从 CLI 维护的 `auth.json` 读取，不上传、不缓存。

本项目修改了 `commandcode-api-proxy`（MIT，作者 [thaolaptrinh](https://github.com/thaolaptrinh/commandcode-api-proxy)）在 `node_modules` 内的文件以对齐协议行为，被改文件仍属原作者。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

使用者需自行承担账号受限、套餐终止等后果。

## 故障排查

| 现象 | 原因 |
|---|---|
| TPS 显示 `-` | 尚未测速，按 `T` |
| TPS 显示 `E` | 测速失败，多为该模型不在套餐内 |
| 看不到思考内容 | 请求未带 `reasoning_effort`，或值为 `none` |
| 401 | API Key 填了非 `proxy-managed` 的值 |
| 403 / model not recognized | 模型名不对或不在套餐内 |
| `npm install` 后行为变化 | 补丁被覆盖，重跑 `.\scripts\install.ps1` |
| 端口被占用 | 启动器会自动接管本项目的旧实例；若占用者是别的程序，用 `-Port` 换端口 |

## 卸载

```powershell
.\scripts\stop-proxy.ps1
.\scripts\make-shortcut.ps1 -Remove
```

删除项目目录即可。不写注册表、不装系统服务、不改 PATH。

## License

[MIT](LICENSE)
