# 官方 CLI 上游协议逆向报告

- 目标：`%APPDATA%\npm\node_modules\command-code\dist\cli.mjs`（`npm i -g command-code` 后本机路径）
- 版本：`command-code@1.50.0`
- 方法：静态提取（发布产物，2.49 MB，压缩但未混淆，`__name` 标记保留原函数名）
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
x-oss-primary-provider  x-session-id  x-cmd-zdr
x-cmd-provider-deepseek-internal
```

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
