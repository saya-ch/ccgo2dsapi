# Changelog

## Unreleased

### 修复

- **额度耗尽时验证结果显示假绿** —— `verify-anthropic` / `verify-parity` 遇到 429 时
  把跳过当成功（退出码 0、差异 0），`verify-all` 的 `code === 0 && diffs === 0` 判定
  因此打印 PASS。现在子脚本用退出码 `2` + 「N 组因额度跳过」标注表示「未验完」，
  `verify-all` 把这种结果单独记为 SKIP 并以退出码 1 结束。退出码约定：
  `0` 通过 / `1` 有真实差异 / `2` 未验完（额度不足）。顺带修正 `verify-all` 注释里
  早已废弃的 8788 端口说明。

### 修复（协议能力与文档对齐）

- **`/v1/models` 的 `effort.supported_levels` 按模型给出** —— 之前所有模型都返回
  `["low","high","max"]`，缺 `off` 且不分模型。现在与官方 CLI 1.87.1 的
  `reasoningEfforts` 一致（v4.1 系含 `off/low/high/max`，v4-flash 为 `off/high/max` 等）。
- **不支持视觉的模型收到图片时剥离** —— 按官方 CLI `stripImages` 的文案换成
  `<attached_image index="N">` 或 `[image omitted: the active model is text-only]`，
  不再把图片直发上游。
- **不支持思考或档位非法的模型不再传 `reasoning_effort`** —— 对齐官方
  `supportsThinking && isThinkingEffort` 的行为。
- **`tool-result` 流式事件对齐官方** —— 仅 `providerExecuted === true` 时产出
  `server_tool_result`，`output` 包成 `{ type: "json", value }`；三套响应把它以文本
  透出，不再静默丢弃（上游当前不返回该事件，属防御性处理）。
- **文档纠错** —— 请求日志实际默认开启（原写「默认关闭」）；DeepSeek 上下文窗口是
  1000000 而非 1048576；凭据为进程内缓存（原写「不缓存」）；`x-cli-surface` 在普通
  CLI 模式不发送；分析对象版本为 1.87.1（NOTICES 原写 1.50.0）；401 与 max_tokens
  的表述一并修正。

## v1.2.0

会话中断、请求被拒、模型反复推理这三类问题的根因修复。其中前三项是会直接
让用户看到失败的缺陷，后面几项是静默的上下文丢失。

### 修复

- **`max_tokens` 超过上游上限导致请求被拒** —— 上游硬上限是 200000，超过直接 400：
  `Validation error: Too big: expected number to be <=200000 at "params.max_tokens"`。
  客户端常配 256000（DSH 的默认值），整条请求在推理开始前就被拒，而客户端把它归类成
  传输错误，界面显示成「流意外中断」。三套协议现在都钳制到上限内。
- **工具配对断裂导致请求失败** —— 上游会校验 tool-call 与 tool-result 的配对，
  缺失时直接报 `Tool result is missing for tool call c1.`。工具执行途中取消、
  上下文裁剪切断配对都会触发。现在发往上游前统一修补，补一条说明「该调用没有结果、
  不要编造」的占位结果。
- **客户端主动断开被误报成上游截断** —— 切换会话或点「继续」时连接被关闭，
  之前会被判定为截断并报错，让用户以为会话失败。
- **错误帧混入 chunk 字段** —— 之前发的是 `{error:{...}, id, object, choices:[]}`，
  客户端看到 `choices` 就按普通 chunk 解析，错误被吞掉，最终表现成「流没有 finish」。
  现在错误帧是纯 `{"error": {...}}`。
- **`fetch` 层失败不参与重试** —— 重试循环只看 HTTP 状态码，DNS 失败、连接重置、
  TLS 错误会直接穿透。现在这些也进入指数退避。
- **发 200 之前先确认上游活着** —— 上游有概率在建连后不久重置连接。SSE 一旦
  `writeHead(200)` 就无法改状态码，之前只能报错。现在先取一个事件，拿不到就整体重试。
- **面板版本号一直是 v1.0.0** —— `/health` 里写死的字面量，package.json 升级后不跟随。

### 新增

- **历史思维链回传** —— 之前 OpenAI 与 Responses 两条路径完全丢弃 `reasoning_content`，
  模型看不到自己上一轮的推理。180 次对照实验确认：只有**同时**满足「请求带 tools」
  与「回传 reasoning_content」，历史思考才会被拼接进上下文（21/60 对 0/120，
  Fisher p=5.98×10⁻¹²）。现在三套协议都按此实现，并在不带 tools 时跳过以省上下文。
- **`normalizeToolPairs()`** —— 修补 tool-call/tool-result 配对。
- **错误原因透出** —— `describeFetchError()` 从 `error.cause` 取出 `ECONNRESET` /
  `UND_ERR_SOCKET` 等真实原因，不再只有一句 `fetch failed`。
- **请求日志增加 `end` 字段** —— `ok` / `truncated` / `client_gone` / `upstream_error`，
  每次请求的收尾状态可查。

### 变更

- 请求日志默认开启，写到 `~/.commandcode/ccgo2dsapi-requests.log`。
  `--request-log off` 可关闭。
- 首事件与事件间隔使用不同超时：`--first-event-timeout`（默认 600 秒）、
  `--idle-timeout`（默认 180 秒）。之前用同一个阈值管两件事。

### 文档

- `docs/COMMAND-CODE-PROTOCOL.md` 补充：上游 `max_tokens` 上限、上下文窗口、
  连接重置行为、180 次思考回传实验的完整数据与统计、方法论教训。
- `docs/COMMAND-CODE-PROTOCOL.md` 新增第 12 节：上游是**路由层**而非自部署，
  同一模型的不同请求可能由不同 provider 服务。这解释了 TPS 波动、连接偶发重置、
  缓存行为不一致等现象，也确立了「不要假设上游行为恒定」的排查原则。
- 两版 README 补充排障条目，并明确本项目**只对 Go 套餐有意义** ——
  GOAT 及以上套餐有官方 API（`https://api.commandcode.ai/provider/v1`）。

## v1.1.0

离线验证、请求日志、重试、元数据实时化。

### 新增

- **`tools/mock-upstream.mjs`** —— 本地 mock 上游，按请求内容回放对应的 NDJSON
  事件流。支持 `--scenario truncated|abort|error` 制造异常场景。
- **`tools/verify-offline.mjs`** —— 离线验证，15 项断言，零额度消耗。
  `npm run verify:offline` 可在改动后随时跑；真实验证只在需要确认「协议对齐」时跑。
- **请求日志** —— 每请求一行 JSON Lines，`--request-log <path>` 启用（默认关闭）。
  含 protocol / model / stream / status / in / out / reasoning / ms。
- **429 与 5xx 重试** —— 指数退避 2 次（`--retries` 可调），终态错误不重试
  （`premium_credits_exhausted` / `model_not_in_plan` / `insufficient credits`）。
- **模型元数据实时拉取** —— 启动时从上游 `/provider/v1/models` 拉取，失败回落硬编码。
  之前面板实时拉、`/v1/models` 硬编码，数据源不一致。

### 修复

- 图片 `mimeType` 不再一律假设 `image/png`：data URL 取声明值，http(s) URL 按扩展名
  推断，都拿不到就省略让上游判断。
- `/user/balance` 语义澄清：返回的是套餐周期内剩余额度，不是官方的「账户余额」。

## v1.0.0

自研网关，移除全部第三方依赖。

### 破坏性变更

- **Responses 协议移到 8787**，不再使用独立的 8788 适配层进程。
- **移除 `commandcode-api-proxy` 依赖** —— 协议层改为 `vendor/` 下自研实现。
- 移除 4 个 `patch-*.mjs` 补丁脚本（已无 dist 需要打补丁）。
- `install.ps1` 不再执行 `npm install`，改为 vendor 自检。

### 新增

- **`vendor/wire.mjs`** —— 上游协议层，依据对官方 CLI 1.50.0 发布产物的静态分析实现。
  差异点：`User-Agent` 用官方值 `cli`；图片块带 `mimeType`；补齐 `x-cmd-zdr` /
  `x-oss-primary-provider` / `x-cmd-provider-deepseek-internal`；标准 W3C `traceparent`；
  截断检测（无 finish 且无 abort → 可重试 502）；从 `outputTokenDetails.reasoningTokens`
  提取推理 token。
- **`vendor/translate.mjs` / `responses.mjs` / `server.mjs`** —— 三套协议的单进程实现。
- **`scripts/swap-gateway.ps1`** —— 零中断热替换：备用端口起新实例 → 健康检查 →
  真实补全验证 → 才停旧进程。7-9 秒完成。
- **`docs/COMMAND-CODE-PROTOCOL.md`** —— 逆向记录，逐条标注「观察 / 推断 / 未知」。
- **`/user/quota`** —— 本项目形状的额度视图，含 5 小时 / 每周窗口与重置时刻。
- **`/user/balance`** —— 官方形状。

### 修复（基于三方评审 + 冷上下文复审，共 30 项）

流式相关：
- 流截断被当成成功（三条路径全部如此）→ 现在校验 `finish`/`abort`。
- 客户端断开后不取消上游请求 → 接入 `AbortController`。
- OpenAI 出错后仍发 `[DONE]` → 失败不再伪装成正常结束。
- Anthropic 错误路径不关闭 content block → 客户端永远等不到 `content_block_stop`。
- tool_calls 整块下发 → 改为官方两片式（首片 id/name + 空 arguments，次片增量）。

协议层：
- `thinking` 块形状错误（`{type:"thinking",thinking}` → `{type:"reasoning",text}`），
  多轮对话会丢历史思考或 400。
- `stopReason` 只认两个字面值 → 改用 `normalizeStopReason`，截断不再误报为正常结束。
- thinking 收尾不关 text 块 → 多段推理产出非法块序。
- `thinking:{type:"disabled"}` 被 `output_config.effort` 覆盖。
- `providerExecuted` 的 tool_use 跳过前不登记 `toolNames` → 孤立 tool_result。

健壮性：
- 413 在 `req.destroy()` 后不可达。
- `readBody` 客户端中断时 Promise 永不 settle。
- `readApiKey` 的 `CCGO_NO_CACHE` 语义写反。
- resize 后 write 会 emit error → 挂监听器 + 顶层兜底。
- SSE 无背压保护。
- 上游 headers 到达后无超时 → 加 idle 超时。

测试完整性：
- `verify-all` 把 SKIP 计入通过（服务未启动时 exit 0）。
- 5 处恒真断言。
- `measure-speed` 不发 `include_usage` 却要求 usage 块。

文档与实现对齐（改代码而非改文档）：
- 非 sentinel 的 API Key 现在真的会转发上游并按结果返回 401。
- `[1M]` 后缀现在真的会被剥离。

### 移除

- `tools/responses-server.mjs`、`tools/responses.js`、4 个补丁脚本。
- `package.json` 的 `dependencies`（现在是零依赖）。
- `config.example.json` 的 `Responses` / `ProxyPackage` 配置项。
