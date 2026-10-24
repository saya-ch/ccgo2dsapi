# 官方 CLI 上游协议逆向报告

- 目标：`%APPDATA%\npm\node_modules\command-code\dist\cli.mjs`（`npm i -g command-code` 后本机路径）
- 版本：`command-code@1.87.1`（2026-10-22 复核；此前基于 1.50.0）
- 方法：静态提取（发布产物，3.34 MB，压缩但未混淆，`__name` 标记保留原函数名）
- 性质：**观察**（源码字面量）/ 推断 / 未知，逐条标注

---

## 1. 端点表（观察）

```
POST /alpha/generate             默认推理端点（tk）
GET  /alpha/whoami               身份
GET  /alpha/billing/credits      额度窗口
GET  /alpha/billing/subscriptions  套餐
GET  /alpha/usage/summary        用量汇总
GET  /alpha/taste/:projectSlug   风格
POST /alpha/learn                学习
POST /alpha/lifecycle-events     埋点
POST /alpha/share/append         分享
     /alpha/devrel-thread/{create,delete,update}
```

模型目录：CLI 里**没有** `/provider/v1/models` 字面量（`0 处命中`）。
说明该端点是第三方代理包自行发现的，或通过其他路径拼装 —— **未知**。

## 2. 请求头（观察，`buildCommandApiHeaders`）

```js
{
  "Content-Type": "application/json",
  "x-cli-environment": normalizeCliEnvironment(getTelemetryEnv()),
  Authorization: `Bearer ${authKey}`,          // 有 key 时
  traceparent: `00-${traceId}-${spanId}-01`,   // 有 trace 时
  "User-Agent": "cli",                          // 注意 wy="cli"
  "x-command-code-version": cliVersion,         // 有版本时
  "x-cmd-zdr": "1",                             // ZDR 开启时
  "x-cmd-provider-deepseek-internal": "1",      // DeepSeek 内部通道开启时
}
```

### 头部常量全集（`Sy`）
```
x-oauth-token  x-oauth-provider  x-project-slug
x-taste-learning  x-cli-environment  x-command-code-version
x-cli-surface  x-oss-primary-provider  x-session-id  x-cmd-zdr
x-cmd-provider-deepseek-internal
```

另有 `x-api-key`（Anthropic 风格鉴权）、`x-opencode-session`（OpenCode 集成）。

### 1.87.1 相对 1.50.0 的变化

复核结论：**协议主体未变**，请求体结构、`User-Agent: cli`、默认 `max_tokens: 64000`、
流式事件类型全部一致。新增三处：

| 变化 | 内容 | 本项目处理 |
|---|---|---|
| `x-cli-surface` 头 | 新增，取值 `cli` / `ide` / `desktop` 等 | **已实现**（`buildHeaders` 支持 `cliSurface`） |
| `/alpha/fingerprint/record` | 设备指纹上报，见下 | 不实现，风险已记录 |
| `/alpha/agent/generate` | Agent 定义生成，与协议网关无关 | 不适用 |

新增端点全量（1.87.1）：

```
/alpha/generate              推理（本项目使用）
/alpha/agent/generate        Agent 定义生成
/alpha/whoami                身份
/alpha/billing/credits       额度窗口
/alpha/billing/subscriptions 套餐
/alpha/usage/summary         用量汇总
/alpha/fingerprint/record    设备指纹上报
/alpha/sandbox/*             沙箱会话（start/stop/status/stream/input/...）
/alpha/web-search, web-fetch 服务端工具
/alpha/taste/*, /beta/taste/* 风格数据
/provider/v1/systemone       Provider API（GOAT 及以上套餐用）
```

### 设备指纹上报（1.87.1 新增，与本项目相关）

`recordCliFingerprint` 采集以下信号，哈希成 `thumbmark` 后 POST 到
`/alpha/fingerprint/record`，并带 `Authorization: Bearer <key>`：

```
readMachineId      机器码
readMacAddresses   MAC 地址
readGitEmail       git 配置里的邮箱
detectContainer    是否在容器内
readTimezone       时区
```

命名空间 `command-code:device-fingerprint:v1`，每个进程只上报一次（内部 `aP` 标志），
且受 `isTelemetryEnabled()` 控制。

**对本项目的影响**：官方 CLI 会主动上报设备指纹，这解释了上游为什么能按设备绑定账号。
本项目**不上报**（不采集这些信号），但需要用户知道：上游的风控依据之一就是这套指纹，
所以「同一密钥多机使用」比单机更容易触发限制。

### 与 npm 代理包的差异（重要）
| 头 | 代理包 | 官方 CLI |
|---|---|---|
| `User-Agent` | `commandcode-cli/<ver> Node.js/<v>` | **`cli`** |
| `x-cmd-zdr` | 无 | 有（条件） |
| `x-cmd-provider-deepseek-internal` | 无 | 有（条件） |
| `x-oss-primary-provider` | 无 | 有 |
| `traceparent` | 自造 | `00-<trace>-<span>-01` 标准 W3C |

代理包的 UA 与官方不一致 —— **这是当前实现的一个偏离**。

## 3. `/alpha/generate` 请求体（观察，`createModelClient.complete`）

```js
{
  config: <resolvedConfig>,        // 来自 config provider
  memory: null,
  taste: null,
  skills: null,
  permissionMode: toWirePermissionMode(mode),   // "auto-accept" | "plan" | "standard"
  threadId: toWireThreadId(threadId),            // UUID 校验，非法则 undefined
  mode: <callParams.mode>,
  promptCache: <callParams.promptCache>,
  params: {
    model: <model>,
    messages: toWireMessages(messages),
    tools: toWireTools(tools),
    system: toWireSystem(systemSections) | <string>,
    max_tokens: maxOutputTokens ?? 64000,        // nk = 64e3
    stream: true,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  },
}
```

关键常量：
- `nk = 64000` —— 默认 max_tokens
- 仅在支持思考的模型上传 `reasoning_effort`

## 4. messages wire 格式（观察，`toWireMessages`）

```js
// assistant
{ role: "assistant", content: [
    { type: "text", text },
    { type: "tool-call", toolCallId, toolName, input },   // input 是对象，非字符串
    { type: "reasoning", text },                          // 注意字段名是 text，不是 thinking
]}

// user（有图时）
{ role: "user", content: [
    { type: "text", text },
    { type: "image", image: `data:${media_type};base64,${data}`, mimeType: media_type },
]}

// tool 结果（独立 role）
{ role: "tool", content: [
    { type: "tool-result", toolCallId, toolName, output: { type: "text", value } },
]}
```

**顺序规则**：工具结果消息先 push，用户内容消息后 push。

### 历史思维链回传（实测：不强制，但应与官方 CLI 一致）

Command Code 是聚合平台，**不能把它等同于某一个厂商的 API 规则**。这里的结论来自实测，
不是从 DeepSeek 官方文档推断的。

#### 实测结果（2026-10-24）

带 tools、历史含一轮 assistant 工具调用，对比回传与不回传 reasoning 块：

| 场景 | HTTP | 返回 reasoning | 返回 text |
|---|---|---|---|
| 回传 reasoning | 200 | 21 字 | 12 字 |
| 不回传 reasoning | 200 | 0 字 | 29 字 |

各重复 3 次的受控对比（换用需要推理的问题）：

| 组 | 平均 reasoning | 平均 text | reasoning=0 次数 |
|---|---|---|---|
| 回传 | 156 字 | 536 字 | 0/3 |
| 不回传 | 183 字 | 630 字 | 0/3 |

**结论：上游不强制校验。** 不回传不会 400，也不会导致模型停止思考。

> 注意区分：**DeepSeek 官方 API**（`api.deepseek.com`）明确要求带 tools 时必须回传
> `reasoning_content`，否则 400。但那是官方直连端点的规则，Command Code 的
> `/alpha/generate` 不适用。两者是不同的服务，不要混用结论。

#### 官方 CLI 的做法

尽管上游不强制，官方 CLI 仍然会回传。`toWireMessages` 的 assistant 分支：

```js
"thinking" === n.type && e.push({ type: "reasoning", text: n.thinking })
```

无条件转换，没有 `tools` 判断。所以「回传」是这个协议的预期形态，只是服务端不做强制校验。

#### 本项目的选择

与官方 CLI 保持一致，三套协议都把历史思维链转成 `{ type: "reasoning", text }`：

| 客户端协议 | 历史思维链位置 |
|---|---|
| OpenAI Chat Completions | `message.reasoning_content` |
| Anthropic Messages | `content` 里 `{ type: "thinking", thinking }` |
| Responses | 独立的 `{ type: "reasoning", summary: [...] }` item |

三个实现细节（每个都会造成静默失败）：

1. **wire 字段名是 `text` 而不是 `thinking`**。写错会被上游当未知字段丢掉，不报错。
2. **Responses 的 reasoning 是独立 item**，与 `function_call` 分开到达，需先暂存再附加到
   下一个 assistant 消息上。
3. **`reasoning.summary` 的块类型是 `summary_text`**。文本提取若只认
   `input_text`/`output_text`/`text`，会得到空字符串 —— 块存在但内容为空，看起来正常，
   实际什么都没回传。

#### 不要据此解释「模型反复推理」

曾经把「模型反复陈述同一结论」归因于历史 reasoning 丢失，**这个归因没有证据支持**：
实测不回传时模型仍然正常推理。遇到反复现象应先排查上下文长度、指令冲突等其它原因，
不要把这条规则当作解释。

## 5. tools / system（观察）

```js
toWireTools  = t => ({ name, description, input_schema })
toWireSystem = sections => ({ type: "text", text, cache_control?: {type:"ephemeral"} })
```
system 除最后一段外，每段末尾追加 `\n`。

## 6. 流式事件（观察，`consumeStream`）

| 事件 `type` | 字段 | 处理 |
|---|---|---|
| `text-delta` | `text` | 累积到 text 块，触发 `onTextDelta` |
| `reasoning-start` | — | 非交错模式下先 finalize 前一个 thinking |
| `reasoning-delta` | `text` | 累积到 thinking 块 |
| `reasoning-end` | — | finalize thinking |
| `tool-call` | `toolCallId` `toolName` `input`/`args` `providerExecuted` | 产出 tool_use |
| `tool-result` | `toolCallId` `toolName` | 服务端工具结果 |
| `finish` | `totalUsage` `rawFinishReason` `finishReason` `systemPromptTokens` | 收尾，记录 usage |
| `provider-metadata` | `providerMetadata.anthropic.usage.cache_creation.ephemeral_1h_input_tokens` | 缓存写入 token |
| `error` | `error`（字符串或对象） | 抛 transportError |
| `abort` | — | 正常结束 |

**截断判定**：既没有 `finish` 也没有 `abort` → 抛
`"Stream ended unexpectedly before completion (no finish event) — response was truncated"`，HTTP 502，可重试。

### usage 字段名（观察）
```
totalUsage.inputTokens / outputTokens
totalUsage.inputTokenDetails.cacheReadTokens / cacheWriteTokens
```

## 7. 错误判定（观察）

```js
// 终态错误标记：不重试
TERMINAL = ["premium_credits_exhausted", "model_not_in_plan", "insufficient credits"]

isRetryable = e.isRetryable === true
  || (status != null ? isRetryableStatus(status) : (e.isRetryable !== false && !hasTerminalMarker(msg)))
```

## 8. finishReason 归一（观察）

```js
raw.toLowerCase():
  tool_use | tool-calls | tool_calls  -> "tool_use"
  length | max_tokens                 -> "max_tokens"
  其它                                 -> "end_turn"
```

## 9. permissionMode 归一（观察）

```js
bypass -> "auto-accept"
auto-accept | plan -> 原样
其它 -> "standard"
```

## 10. threadId 校验（观察）

```js
toWireThreadId = id => UUID_RE.test(id) ? id : undefined
```

## 11. 视觉能力（观察）

```js
const r = !registry.supportsVision({model}) && hasImage2({messages})
  ? stripImages({messages})
  : messages;
```
不支持视觉的模型收到图片时，会把图片替换成占位文本，而非报错。
这与我们实测「v4-flash 回没有图片」一致。

---

## 与 npm 代理包的差异汇总

| 项 | npm 代理包 | 官方 CLI | 影响 |
|---|---|---|---|
| `User-Agent` | `commandcode-cli/<v> Node.js/<v>` | `cli` | 可能触发风控比对 |
| `x-cmd-zdr` | 无 | 有 | 缺失可能被识别为非官方 |
| `x-cmd-provider-deepseek-internal` | 无 | 有 | 同上 |
| `x-oss-primary-provider` | 无 | 有 | 未知 |
| `reasoning` 块字段 | `text` | `text` | 一致 |
| `image.mimeType` | **无** | **有** | 可能是图片处理的关键差异 |
| 默认 max_tokens | 各接口自带 | `64000` | 一致 |

---

## 未知项（未能确认）

1. `config` 对象的完整结构 —— 仅知 `workingDir/date/environment` 等由 CLI 组装
2. `/provider/v1/models` 的实际来源 —— CLI 内无该字面量
3. `x-oss-primary-provider` 的取值语义
4. `traceparent` 的 traceId 生成算法（`getTraceId`）
5. 反代检测的具体判据（未见 "Proxy use detected" 字面量，可能在服务端）
