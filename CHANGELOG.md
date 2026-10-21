# Changelog

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
