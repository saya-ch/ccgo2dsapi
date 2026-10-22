// wire.mjs —— Command Code `/alpha/generate` 协议实现（依据官方 CLI 1.50.0 逆向）
//
// 与第三方包 commandcode-api-proxy 的区别，来自对官方 dist/cli.mjs 的静态提取：
//   · User-Agent 官方是 "cli"，不是 "commandcode-cli/<ver> Node.js/<v>"
//   · image 块带 mimeType 字段（第三方包没有）
//   · 支持 x-cmd-zdr / x-cmd-provider-deepseek-internal / x-oss-primary-provider
//   · traceparent 为 00-<trace>-<span>-01 标准 W3C 格式
//   · 默认 max_tokens = 64000
//   · 截断判定：既无 finish 也无 abort 即视为截断，抛可重试错误
//
// 证据见 docs/COMMAND-CODE-PROTOCOL.md 第 2、3、4、6 节。

import crypto from "node:crypto";

// ── 常量（观察自 cli.mjs）────────────────────────────────
export const ROUTE_GENERATE = "/alpha/generate";
export const ROUTE_WHOAMI = "/alpha/whoami";
export const ROUTE_CREDITS = "/alpha/billing/credits";
export const ROUTE_SUBSCRIPTIONS = "/alpha/billing/subscriptions";
export const ROUTE_USAGE_SUMMARY = "/alpha/usage/summary";

export const DEFAULT_MAX_TOKENS = 64000;

/** 头名常量，对应 cli.mjs 的 Sy 对象 */
export const H = {
  OAUTH_TOKEN: "x-oauth-token",
  OAUTH_PROVIDER: "x-oauth-provider",
  PROJECT_SLUG: "x-project-slug",
  TASTE_LEARNING: "x-taste-learning",
  CLI_ENVIRONMENT: "x-cli-environment",
  CLI_VERSION: "x-command-code-version",
  CLI_SURFACE: "x-cli-surface",
  OSS_PRIMARY_PROVIDER: "x-oss-primary-provider",
  SESSION_ID: "x-session-id",
  CMD_ZDR: "x-cmd-zdr",
  PROVIDER_DEEPSEEK_INTERNAL: "x-cmd-provider-deepseek-internal",
};

/** 终态错误标记：出现即不重试 */
const TERMINAL_ERRORS = [
  "premium_credits_exhausted",
  "model_not_in_plan",
  "insufficient credits",
];

// ── 请求头 ────────────────────────────────────────────────
/**
 * 对应 cli.mjs 的 buildCommandApiHeaders。
 * @param {object} o
 * @param {string} o.authKey       Bearer key
 * @param {string} [o.cliVersion]
 * @param {string} [o.sessionId]
 * @param {string} [o.traceId]
 * @param {string} [o.spanId]
 * @param {string} [o.cliEnvironment]  默认 "production"
 * @param {boolean} [o.zdr]
 * @param {boolean} [o.deepseekInternal]
 * @param {object} [o.extra]
 */
export function buildHeaders(o = {}) {
  const h = {
    "Content-Type": "application/json",
    [H.CLI_ENVIRONMENT]: o.cliEnvironment || "production",
  };
  if (o.authKey) h.Authorization = `Bearer ${o.authKey}`;
  if (o.traceId && o.spanId) h.traceparent = `00-${o.traceId}-${o.spanId}-01`;
  h["User-Agent"] = "cli"; // 官方 wy = "cli"
  // 1.87.1 新增：cli surface 标识（cli / ide / desktop 等）
  if (o.cliSurface) h[H.CLI_SURFACE] = o.cliSurface;
  if (o.cliVersion) h[H.CLI_VERSION] = o.cliVersion;
  if (o.sessionId) h[H.SESSION_ID] = o.sessionId;
  if (o.zdr) h[H.CMD_ZDR] = "1";
  if (o.deepseekInternal) h[H.PROVIDER_DEEPSEEK_INTERNAL] = "1";
  return { ...h, ...(o.extra || {}) };
}

/** sess_ 前缀 + 16 位 hex（观察自 generateSessionId） */
export function generateSessionId() {
  return `sess_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** W3C traceparent 的两段 id */
export function generateTraceIds() {
  return {
    traceId: crypto.randomBytes(16).toString("hex"),
    spanId: crypto.randomBytes(8).toString("hex"),
  };
}

// ── messages 转 wire 格式 ────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toWireThreadId(id) {
  return typeof id === "string" && UUID_RE.test(id) ? id : undefined;
}

export function toWirePermissionMode(mode) {
  if (mode === "bypass") return "auto-accept";
  if (mode === "auto-accept" || mode === "plan") return mode;
  return "standard";
}

/**
 * 工具名直通。
 *
 * 早期版本在这里挂了一个模块级 Map 做名字替换，但从未被调用，
 * 而且是跨请求共享的可变状态 —— 一旦真有人用上，并发请求会互相污染。
 * 现在工具名原样透传；如将来确实需要改写，应当按请求传参而非用全局。
 */
export function toWireToolName(name) {
  return name;
}

export function toWireToolOutput(content) {
  const arr = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
  return {
    type: "text",
    value: arr.filter((c) => c && c.type === "text").map((c) => c.text).join("\n"),
  };
}




// ── 请求体 ────────────────────────────────────────────────
/**
 * 对应 cli.mjs createModelClient 里 body 的构造。
 */
export function buildGenerateBody(o) {
  const params = {
    model: o.model,
    messages: o.messages,
    tools: o.tools,
    system: o.system,
    max_tokens: o.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };
  if (o.temperature !== undefined) params.temperature = o.temperature;
  if (o.effort) params.reasoning_effort = o.effort;

  const body = {
    config: o.config || {},
    memory: o.memory ?? null,
    taste: o.taste ?? null,
    skills: o.skills ?? null,
    permissionMode: toWirePermissionMode(o.permissionMode),
    threadId: toWireThreadId(o.threadId),
    mode: o.mode,
    promptCache: o.promptCache,
    params,
  };
  return body;
}

// ── 流式事件解析 ──────────────────────────────────────────
export function hasTerminalMarker(message) {
  const t = String(message || "").toLowerCase();
  return TERMINAL_ERRORS.some((k) => t.includes(k));
}

export function readStreamErrorEvent(ev) {
  if (typeof ev.error === "string" && ev.error) {
    return { message: ev.error, statusCode: undefined, isRetryable: undefined };
  }
  const e = typeof ev.error === "object" ? ev.error : undefined;
  return {
    message: (typeof e?.message === "string" && e.message) || "Stream error",
    statusCode: e?.statusCode,
    isRetryable: e?.isRetryable,
  };
}

export function normalizeStopReason(raw) {
  const t = String(raw ?? "").toLowerCase();
  if (t === "tool_use" || t === "tool-calls" || t === "tool_calls") return "tool_use";
  if (t === "length" || t === "max_tokens") return "max_tokens";
  return "end_turn";
}

/**
 * 逐行产出的 NDJSON 解析器。
 * 官方是 readLines(stream) 后逐行 JSON.parse，解析失败即跳过。
 */
export async function* readNdjson(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        yield JSON.parse(s);
      } catch {
        // 官方同样跳过无法解析的行
      }
    }
  }
  // 尾部残留可能是不完整的一行，解析失败属正常，跳过即可
  const tail = buf.trim();
  if (tail) {
    try { yield JSON.parse(tail); } catch { /* 不完整的尾行，丢弃 */ }
  }
}

/**
 * 消费上游事件流，产出与官方 consumeStream 等价的中间结构。
 *
 * @returns {{content:Array, usage:object, rawFinishReason:string, stopReason:string,
 *            systemPromptTokens:number|undefined, aborted:boolean}}
 */
export async function consumeStream(stream, opts = {}) {
  const content = [];
  let textPart = null;
  let thinking = "";
  let thinkingOpen = false;
  let sawFinish = false;
  let sawAbort = false;
  let cacheWriteTokens1h;
  let rawFinishReason;
  let stopReason;
  let systemPromptTokens;

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

  const finalizeThinking = () => {
    if (thinkingOpen) {
      if (thinking) content.push({ type: "thinking", thinking, signature: "" });
      thinking = "";
      thinkingOpen = false;
      // 关键：关闭当前 text 块。否则后续 text 会继续累加到前面那个
      // textPart 里，产出 [thinking1, text1+text2, thinking2] 这种错序，
      // Anthropic / Responses 客户端会拒绝或丢弃这类块序。
      textPart = null;
    }
  };

  for await (const ev of readNdjson(stream)) {
    // 上游理论上可能发一行字面量 null，直接取 .type 会抛 TypeError，
    // 那样会丢掉可重试标记，变成未分类异常。跳过非对象事件。
    if (!ev || typeof ev !== "object") continue;
    const t = ev.type;

    if (t === "abort") { sawAbort = true; continue; }

    if (t === "text-delta") {
      // 多段推理：text 开始说明当前 thinking 段已结束
      if (thinkingOpen) finalizeThinking();
      if (!textPart) {
        textPart = { type: "text", text: "" };
        content.push(textPart);
      }
      textPart.text += ev.text ?? "";
      opts.onTextDelta?.(ev.text ?? "");
      continue;
    }

    if (t === "reasoning-start") {
      if (!opts.interleavedThinking) finalizeThinking();
      thinkingOpen = true;
      opts.onThinkingStart?.();
      continue;
    }

    if (t === "reasoning-delta") {
      const d = ev.text ?? "";
      if (d) {
        thinkingOpen = true;
        thinking += d;
        opts.onThinkingDelta?.(d);
      }
      continue;
    }

    if (t === "reasoning-end") {
      finalizeThinking();
      continue;
    }

    if (t === "tool-call") {
      if (thinkingOpen) finalizeThinking();
      textPart = null;
      const name = ev.toolName ?? "";
      const input = ev.input ?? ev.args;
      content.push({
        type: "tool_use",
        id: ev.toolCallId ?? "",
        name,
        input: typeof input === "object" && input !== null ? input : safeParse(input),
        ...(ev.providerExecuted === true ? { providerExecuted: true } : {}),
      });
      continue;
    }

    if (t === "tool-result") {
      textPart = null;
      content.push({
        type: "server_tool_result",
        tool_use_id: ev.toolCallId ?? "",
        name: ev.toolName ?? "",
        output: ev.output ?? ev.result,
        providerExecuted: true,
      });
      continue;
    }

    if (t === "finish") {
      sawFinish = true;
      const u = ev.totalUsage;
      if (u) {
        usage.inputTokens = u.inputTokens ?? 0;
        usage.outputTokens = u.outputTokens ?? 0;
        usage.cacheReadTokens = u.inputTokenDetails?.cacheReadTokens ?? 0;
        usage.cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? 0;
        // 上游 finish 里 outputTokenDetails.reasoningTokens 是真实推理 token 数
        usage.reasoningTokens = u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? 0;
      }
      rawFinishReason = ev.rawFinishReason ?? ev.finishReason;
      // 用统一的归一函数：它处理 max_tokens / tool_use / 大写变体，
      // 内联三元只认两个字面值，会把截断误判成正常结束。
      stopReason = normalizeStopReason(rawFinishReason);
      systemPromptTokens = ev.systemPromptTokens ?? systemPromptTokens;
      continue;
    }

    if (t === "provider-metadata") {
      const n = ev.providerMetadata?.anthropic?.usage?.cache_creation?.ephemeral_1h_input_tokens;
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) cacheWriteTokens1h = n;
      continue;
    }

    if (t === "error") {
      const e = readStreamErrorEvent(ev);
      const msg = e.message;
      const err = new Error(msg);
      err.status = e.statusCode ?? 500;
      err.midStream = true;
      err.retryable = e.isRetryable === true
        ? true
        : e.statusCode != null
          ? isRetryableStatus(e.statusCode)
          : e.isRetryable !== false && !hasTerminalMarker(msg);
      throw err;
    }
  }

  finalizeThinking();

  // 官方：既没有 finish 也没有 abort => 流被截断
  if (!sawFinish && !sawAbort) {
    const err = new Error(
      "Stream ended unexpectedly before completion (no finish event) — response was truncated"
    );
    err.status = 502;
    err.retryable = true;
    err.midStream = true;
    throw err;
  }

  if (cacheWriteTokens1h !== undefined) usage.cacheWriteTokens1h = cacheWriteTokens1h;

  return { content, usage, rawFinishReason, stopReason, systemPromptTokens, aborted: sawAbort };
}

function safeParse(s) {
  if (typeof s !== "string") return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}

/** 带超时与中止的 fetch（官方 fetchWithTimeout） */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 600000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ac.abort();
  if (init.signal) {
    if (init.signal.aborted) ac.abort();
    else init.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener?.("abort", onAbort);
  }
}

// ══════════════════════════════════════════════════════════
// 直通事件解析（避免重复 JSON.parse）
// ══════════════════════════════════════════════════════════
// idle 超时：上游「发一半静默」时必须有兜底。
// 从环境变量读，避免 wire.mjs 依赖命令行解析（那是 server.mjs 的职责）。
const IDLE_TIMEOUT_MS = Number(process.env.CCGO_IDLE_TIMEOUT_MS || 180000);

/**
 * 逐行产出上游 NDJSON 事件。
 *
 * fetchWithTimeout 的超时只覆盖到响应头，headers 到达后就没有任何时限了。
 * 上游「发一半静默」会让请求永久挂起，所以这里加 idle 超时：
 * 超过 IDLE_TIMEOUT_MS 没有新数据就判定卡死并抛错。
 */
export async function* readNdjsonEvents(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    const nextPromise = iterator.next();
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        rej(Object.assign(new Error(`upstream idle for ${IDLE_TIMEOUT_MS}ms`), {
          status: 504, retryable: true, midStream: true,
        }));
      }, IDLE_TIMEOUT_MS);
      timer.unref?.();
    });

    let step;
    try {
      step = await Promise.race([nextPromise, timeout]);
    } catch (e) {
      try { await iterator.return?.(); } catch { }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (step.done) break;
    const chunk = step.value;
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const line2 = line.trim();
      if (!line2) continue;
      try { yield JSON.parse(line2); } catch { }
    }
  }
  const tail = buf.trim();
  if (tail) { try { yield JSON.parse(tail); } catch { } }
}
