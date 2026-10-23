// server.mjs —— 自研网关：把 wire 层包装成 OpenAI / Anthropic / Responses 三套接口
//
// 用法：
//   node vendor/server.mjs --port 8787 --auth <path-to-auth.json>
//
// 设计：单一进程、单端口，三套协议共用同一条上游通道。

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHeaders, buildGenerateBody,
  consumeStream, generateSessionId, generateTraceIds, toWirePermissionMode,
  ROUTE_GENERATE, ROUTE_CREDITS, ROUTE_SUBSCRIPTIONS, ROUTE_WHOAMI,
  DEFAULT_MAX_TOKENS, fetchWithTimeout, isRetryableStatus, hasTerminalMarker,
} from "./wire.mjs";

import {
  openAIToWire, wireToOpenAIMessage, wireToOpenAIFinish, wireToOpenAIUsage,
  anthropicToWire, wireToAnthropicBlocks, wireToAnthropicStop, wireToAnthropicUsage,
  openAIError, anthropicError,
} from "./translate.mjs";

import {
  responsesToWire, createSeq, newResponseId, newItemId, toResponsesUsage,
  wireToOutputItems, makeResponseObject,
} from "./responses.mjs";

// ── 配置 ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const PORT = Number(argOf("--port", "8787"));
const HOST = argOf("--host", "127.0.0.1");
const API_BASE = argOf("--base", "https://api.commandcode.ai");
const AUTH_FILE = argOf("--auth", path.join(os.homedir(), ".commandcode", "auth.json"));
const CLI_VERSION = argOf("--cli-version", "1.50.0");

// 网关自身版本：从 package.json 读，避免和 /health 的硬编码漂移。
// 之前 /health 写死 "1.0.0"，package.json 升到 1.1.0 后面板仍显示 v1.0.0。
const GATEWAY_VERSION = (() => {
  try {
    // 用 fileURLToPath 而不是手撕 URL —— Windows 盘符与 URL 编码都容易出错
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "package.json");
    const v = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
    return v || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const API_KEY_SENTINEL = argOf("--sentinel", "proxy-managed");

/**
 * 解析调用方提供的凭据。
 *
 * - 没传 / 传空 / 传 sentinel → 用 auth.json 里的密钥（本项目自己的额度）
 * - 传了其它值 → 当作调用方自己的上游密钥原样转发，上游鉴权失败会返回 401
 *
 * 这样 README 里「填别的值会被当作你自己的密钥转发上游」才是真的；
 * 之前那段代码声明了 sentinel 却从未校验，任何字符串都能白用本项目额度。
 */
function resolveApiKey(req) {
  const auth = req.headers["authorization"] || "";
  const xKey = req.headers["x-api-key"] || "";
  const given = (auth.startsWith("Bearer ") ? auth.slice(7) : auth) || xKey || "";

  if (!given || given === API_KEY_SENTINEL) return readApiKey();
  return given;
}
const MAX_BODY = 48 * 1024 * 1024;
const TIMEOUT_MS = Number(argOf("--timeout", "600000"));
const ALLOW_CORS = args.includes("--cors");
const LOG_LEVEL = argOf("--log-level", "info");
// 传了 --log-file 就自己落盘。这样启动方不必用重定向接管子进程的
// stdout/stderr 句柄 —— 那会让 Start-Process 一直等到子进程退出。
const LOG_FILE = argOf("--log-file", "");

let logStream = null;
function openLogFile() {
  if (!LOG_FILE) return;
  try {
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    logStream.on("error", () => { logStream = null; });
  } catch { logStream = null; }
}
openLogFile();

function writeLine(line) {
  if (logStream) {
    try { logStream.write(line + "\n"); } catch { }
  } else {
    console.log(line);
  }
}

function log(...a) {
  if (LOG_LEVEL === "silent") return;
  writeLine("[gateway] " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
}

// ── 请求日志 ──────────────────────────────────────────────
// 每请求一行 JSON Lines，用于回溯「哪个模型、多少 token、耗时多久」。
// 额度异常、慢请求、幻觉排查都需要这个，也是做 usage 聚合的前提。
const REQ_LOG_FILE = (() => {
  const v = argOf("--request-log", "");
  if (v === "off" || v === "false") return null;
  if (v) return v;
  // 默认开启：断流问题没有请求日志无法定位。--request-log off 可关。
  return path.join(os.homedir(), ".commandcode", "ccgo2dsapi-requests.log");
})();

let reqLogStream = null;
if (REQ_LOG_FILE) {
  try {
    reqLogStream = fs.createWriteStream(REQ_LOG_FILE, { flags: "a" });
    reqLogStream.on("error", () => { reqLogStream = null; });
  } catch { reqLogStream = null; }
}

/**
 * 记录一次请求。字段尽量少而有用：
 *   ts / protocol / model / stream / status / in / out / reasoning / ttft_ms / ms
 */
function logRequest(o) {
  if (!reqLogStream) return;
  const rec = {
    ts: new Date().toISOString(),
    protocol: o.protocol,
    model: o.model,
    stream: !!o.stream,
    status: o.status ?? null,
    in: o.in ?? null,
    out: o.out ?? null,
    reasoning: o.reasoning ?? null,
    ttft_ms: o.ttftMs ?? null,
    ms: o.ms ?? null,
    // 收尾状态：ok / truncated / upstream_error / client_gone / timeout
    end: o.end ?? null,
    ...(o.error ? { error: String(o.error).slice(0, 200) } : {}),
  };
  try { reqLogStream.write(JSON.stringify(rec) + "\n"); } catch { }
}

function logError(...a) {
  writeLine("[gateway] " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
}

// ── 鉴权：从 auth.json 读真实 key ─────────────────────────
let cachedKey = null;
function readApiKey() {
  // 缓存是默认行为；CCGO_NO_CACHE 用来强制重新读盘（密钥轮换后无需重启）。
  if (cachedKey && !process.env.CCGO_NO_CACHE) return cachedKey;
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    const k = j.apiKey || j.api_key || j.key || j.token;
    if (!k) throw new Error("auth.json 里没有 apiKey 字段");
    cachedKey = k;
    return k;
  } catch (e) {
    throw new Error(`读取凭据失败 (${AUTH_FILE}): ${e.message}`);
  }
}

// ── 上游调用 ──────────────────────────────────────────────
function makeConfig() {
  return {
    workingDir: process.cwd(),
    date: new Date().toISOString().slice(0, 10),
    environment: process.platform === "win32" ? "win32" : process.platform,
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

async function callUpstream({ model, messages, system, tools, maxTokens, temperature, effort, signal, apiKey: explicitKey }) {
  const apiKey = explicitKey || readApiKey();
  const { traceId, spanId } = generateTraceIds();
  const sessionId = generateSessionId();

  const body = buildGenerateBody({
    config: makeConfig(),
    model,
    messages,
    tools,
    system,
    maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature,
    effort,
    permissionMode: "standard",
    mode: "agent",
  });

  const headers = buildHeaders({
    authKey: apiKey,
    cliVersion: CLI_VERSION,
    sessionId,
    traceId,
    spanId,
    cliEnvironment: "production",
  });

  // 429 / 5xx 做指数退避重试：窗口刚重置时的瞬时限速不该直接暴露给用户。
  // 终态错误（额度耗尽、模型不在套餐内）不重试 —— hasTerminalMarker 判定。
  const MAX_RETRIES = Number(argOf("--retries", "2"));
  let res;
  let lastText = "";
  let lastMsg = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    res = await fetchWithTimeout(
      API_BASE + ROUTE_GENERATE,
      { method: "POST", headers, body: JSON.stringify(body), signal },
      TIMEOUT_MS
    );

    if (res.ok) break;

    lastText = await res.text().catch(() => "");
    lastMsg = lastText;
    try {
      const j = JSON.parse(lastText);
      lastMsg = j.error?.message || j.message || lastText;
    } catch { }

    const willRetry = isRetryableStatus(res.status)
      && !hasTerminalMarker(String(lastMsg))
      && attempt < MAX_RETRIES
      && !signal?.aborted;
    if (!willRetry) break;

    // 指数退避 + 抖动，避免并发时同时重试
    const wait = 400 * Math.pow(2, attempt) + Math.random() * 200;
    log(`upstream ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(wait)}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }

  if (!res.ok) {
    let code = null;
    try {
      const j = JSON.parse(lastText);
      code = j.error?.code || null;
    } catch { }
    const msgText = typeof lastMsg === "string" ? lastMsg : JSON.stringify(lastMsg ?? "");
    const err = new Error(msgText.slice(0, 500));
    err.status = res.status;
    err.code = code;
    err.retryable = isRetryableStatus(res.status) && !hasTerminalMarker(msgText);
    throw err;
  }

  return res;
}

/**
 * 为一次流式响应建立中止通道：客户端断开时取消上游请求，
 * 避免连接已死还继续读上游、白耗配额。
 */
function makeAbortChannel(res) {
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on("close", onClose);
  return {
    signal: ac.signal,
    cleanup: () => res.off("close", onClose),
  };
}

// ── HTTP 工具 ─────────────────────────────────────────────
/**
 * 安全写入：客户端可能已经断开（流式响应尤其常见），
 * 此时 res.write 会抛 ERR_STREAM_WRITE_AFTER_END 或静默失败。
 * 所有流式输出都走这里，断开后直接跳过，不制造未捕获异常。
 */
function safeWrite(res, chunk) {
  // ServerResponse 在 destroyed 之后 write 会异步 emit 'error'
  // (ERR_STREAM_DESTROYED)。没有监听器的话会升级成 uncaughtException，
  // 单进程网关直接退出。
  if (!res.__ccgoErrHooked) {
    res.__ccgoErrHooked = true;
    res.on("error", () => { });
  }
  if (res.writableEnded || res.destroyed) return false;
  try {
    // res.write 返回 false 表示写缓冲已满。这里不 await drain（那会阻塞
    // 上游读取），但记录下来：持续积压说明客户端太慢，继续读上游只会
    // 让内存无界增长。
    const ok = res.write(chunk);
    if (!ok) {
      res.__ccgoBacklog = (res.__ccgoBacklog || 0) + 1;
    } else {
      res.__ccgoBacklog = 0;
    }
    return true;
  } catch {
    return false;
  }
}

function safeEnd(res) {
  if (res.writableEnded || res.destroyed) return;
  try { res.end(); } catch { }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY) {
        // 先停读并让调用方回 413，再销毁连接。
        // 直接 req.destroy() 会把 socket 一起杀掉，413 就发不出去了。
        req.pause();
        fail(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("invalid json"), { status: 400 }));
      }
    });

    // 客户端上传到一半断开时只发 close，不发 error/end。
    // 不监听 close 的话这个 Promise 永远不会 settle，handler 闭包连同
    // 已缓冲的 chunks 一起泄漏。
    req.on("error", fail);
    req.on("close", () => fail(Object.assign(new Error("client aborted"), { status: 499 })));
  });
}

function applyCors(res) {
  if (!ALLOW_CORS) return;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

// ── 模型名归一：短名 → 上游完整 id ────────────────────────
// 官方 deepseek-flash == V4.1-Flash（旧名 v4-flash 已下线但上游仍作为独立模型存在）
const MODEL_ALIASES = {
  "deepseek-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4.1-flash-fast": "deepseek/deepseek-v4.1-flash-fast",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek-v4-flash-fast": "deepseek/deepseek-v4-flash-fast",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp": "deepseek/deepseek-v4-flash-vision-exp",
  "deepseek-vision": "deepseek/deepseek-v4-flash-vision-exp",
};

function resolveModel(m) {
  // 非字符串（number/object/null）一律回落到默认模型，不要在这里抛
  // TypeError —— 那是 500，而实际情况应该是 400 或直接用默认值。
  if (typeof m !== "string" || !m) return "deepseek/deepseek-v4.1-flash";

  // Claude Code 用 model[1M] 声明上下文窗口，这是它自己的语法，
  // 不能原样发给上游。剥掉后再解析。
  const cleaned = m.replace(/\[(?:1m|1M)\]$/i, "").trim();
  if (!cleaned) return "deepseek/deepseek-v4.1-flash";

  if (cleaned.includes("/")) return cleaned;
  m = cleaned;
  const k = m.toLowerCase();
  if (MODEL_ALIASES[k]) return MODEL_ALIASES[k];
  // Anthropic 官方语义：claude-opus* -> pro，sonnet/haiku/fable/其它 claude* -> flash
  if (k.startsWith("claude")) {
    if (k.includes("opus")) return "deepseek/deepseek-v4-pro";
    return "deepseek/deepseek-v4.1-flash";
  }
  return m;
}

// ── 模型元数据 ────────────────────────────────────────────
// 硬编码只是回落值。运行时优先从上游 /provider/v1/models 拉取，
// 否则面板（实时拉取）和 /v1/models（硬编码）会数据源不一致：
// 上游新增模型时面板显示、API 不显示。
const MODEL_META_FALLBACK = {
  "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", ctx: 1000000, vision: true },
  "deepseek/deepseek-v4.1-flash-fast": { name: "DeepSeek V4.1 Flash Fast", ctx: 1000000, vision: true },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", ctx: 1000000, vision: false },
  "deepseek/deepseek-v4-flash-fast": { name: "DeepSeek V4 Flash Fast", ctx: 1000000, vision: false },
  "deepseek/deepseek-v4-flash-vision-exp": { name: "DeepSeek V4 Flash Vision (exp)", ctx: 1000000, vision: true },
  "deepseek/deepseek-v4-pro": { name: "DeepSeek V4 Pro", ctx: 1000000, vision: false },
};

/** 运行时模型元数据：启动时从上游拉取，失败则用回落值 */
let MODEL_META = { ...MODEL_META_FALLBACK };
let MODEL_META_SOURCE = "fallback";

const VISION_HINTS = /vision|v4\.1|multimodal/i;

async function refreshModelMeta() {
  try {
    const apiKey = readApiKey();
    const { traceId, spanId } = generateTraceIds();
    const headers = buildHeaders({ authKey: apiKey, cliVersion: CLI_VERSION, traceId, spanId });
    const r = await fetchWithTimeout(API_BASE + "/provider/v1/models", { method: "GET", headers }, 10000);
    if (!r.ok) return false;
    const j = await r.json();
    const list = Array.isArray(j?.data) ? j.data : [];
    if (list.length === 0) return false;

    const next = {};
    for (const m of list) {
      if (!m?.id || !String(m.id).startsWith("deepseek/")) continue;
      next[m.id] = {
        name: m.name || m.displayName || m.id,
        ctx: m.context_length ?? m.contextLength ?? 1000000,
        vision: VISION_HINTS.test(String(m.id)),
      };
    }
    if (Object.keys(next).length === 0) return false;

    MODEL_META = next;
    MODEL_META_SOURCE = "live";
    log(`model metadata: ${Object.keys(next).length} models from upstream`);
    return true;
  } catch (e) {
    log("model metadata refresh failed, using fallback: " + e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// OpenAI Chat Completions
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// 流错误描述
// ══════════════════════════════════════════════════════════
/**
 * 把流式过程中的异常翻译成对用户有用的话。
 *
 * 关键原则：不要用固定文案盖掉真实原因。之前把 idle 超时统一写成
 * "upstream stream truncated"，结果日志和界面都看不出是超时，
 * 排查方向完全跑偏。
 */
function describeStreamError(e, sawFinish, sawAbort) {
  const raw = String(e?.message || e || "unknown").trim();

  // 超时类：明确说是等待超时，并给出可调参数
  if (/idle for|sent no data for/i.test(raw)) {
    return `upstream timed out: ${raw}`;
  }
  if (/timeout|timed out|aborted/i.test(raw) && !/truncated/i.test(raw)) {
    return `upstream timeout: ${raw}`;
  }

  // 已经收到 finish/abort 才出错：是收尾阶段的问题，如实转述
  if (sawFinish || sawAbort) return raw;

  // 真的在没有任何终止事件的情况下结束：这才叫截断
  return `upstream stream truncated before completion (${raw})`;
}

async function handleOpenAI(req, res) {
  const body = await readBody(req);
  const t = openAIToWire(body);
  const model = resolveModel(body.model);
  const stream = body.stream === true;

  // A4: 客户端断开时取消上游请求。只对流式生效 —— 非流式没有长连接可断。
  const abortCh = stream ? makeAbortChannel(res) : null;

  let upstream;
  try {
    upstream = await callUpstream({
      model,
      messages: t.messages,
      system: t.system,
      tools: t.tools.length ? t.tools : undefined,
      maxTokens: t.maxTokens,
      temperature: t.temperature,
      // 官方 DeepSeek 默认开启思考模式；未显式指定时给 high
      effort: t.effort === undefined ? "high" : t.effort,
      signal: abortCh?.signal,
      apiKey: resolveApiKey(req),
    });
  } catch (e) {
    abortCh?.cleanup();
    throw e;
  }

  const id = "chatcmpl-" + Math.random().toString(36).slice(2, 14);
  const created = Math.floor(Date.now() / 1000);

  const t0 = Date.now();

  if (!stream) {
    const r = await consumeStream(upstream.body);
    const message = wireToOpenAIMessage(r.content);
    logRequest({
      protocol: "openai", model, stream: false, status: 200,
      end: "ok",
      in: r.usage?.inputTokens, out: r.usage?.outputTokens,
      reasoning: r.usage?.reasoningTokens, ms: Date.now() - t0,
    });
    return sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: wireToOpenAIFinish(r.stopReason, r.content) }],
      usage: wireToOpenAIUsage(r.usage),
    });
  }

  sendSseHeaders(res);
  const emit = (obj) => safeWrite(res, `data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish = null) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  emit(chunk({ role: "assistant", content: "" }));

  let sawToolUse = false;
  let toolIndex = 0;
  let sawFinish = false;
  let sawAbort = false;
  let failed = false;

  try {
    for await (const ev of readEvents(upstream.body)) {
      // A4: 客户端断开后停止消费，不再向上游要数据
      if (res.writableEnded || res.destroyed) break;
      // B5: 客户端持续跟不上，放弃这条流，避免内存无界增长
      if ((res.__ccgoBacklog || 0) > 5) {
        log("client too slow, dropping stream");
        break;
      }
      if (ev.type === "abort") { sawAbort = true; continue; }
      if (ev.type === "text-delta" && ev.text) {
        emit(chunk({ content: ev.text }));
      } else if (ev.type === "reasoning-delta" && ev.text) {
        emit(chunk({ reasoning_content: ev.text }));
      } else if (ev.type === "tool-call") {
        sawToolUse = true;
        const args = JSON.stringify(ev.input ?? {});
        const idx = toolIndex++;
        const callId = ev.toolCallId || "call_" + Math.random().toString(36).slice(2, 10);

        // 首片：带 id / name，arguments 为空字符串
        emit(chunk({
          tool_calls: [{
            index: idx,
            id: callId,
            type: "function",
            function: { name: ev.toolName ?? "", arguments: "" },
          }],
        }));
        // 次片：只有 index + arguments 增量，与官方分片形态一致
        if (args.length > 0) {
          emit(chunk({
            tool_calls: [{ index: idx, function: { arguments: args } }],
          }));
        }
      } else if (ev.type === "finish") {
        sawFinish = true;
        const u = ev.totalUsage;
        const usage = wireToOpenAIUsage({
          inputTokens: u?.inputTokens, outputTokens: u?.outputTokens,
          cacheReadTokens: u?.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens,
          reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? u?.reasoningTokens,
        });
        emit(chunk({}, sawToolUse ? "tool_calls" : "stop"));
        // 官方：include_usage 时在末尾追加一个 choices 为空的独立 usage 块
        if (body.stream_options?.include_usage) {
          emit({ id, object: "chat.completion.chunk", created, model, choices: [], usage });
        }
        logRequest({
          protocol: "openai", model, stream: true, status: 200,
          end: "ok",
          in: u?.inputTokens, out: u?.outputTokens,
          reasoning: u?.outputTokenDetails?.reasoningTokens ?? u?.reasoningTokens,
          ms: Date.now() - t0,
        });
      } else if (ev.type === "error") {
        // A2: 错误后必须立刻停止，且不能再发 [DONE] —— 那等于把失败说成成功
        failed = true;
        const e = typeof ev.error === "string" ? ev.error : ev.error?.message;
        emit({
          ...openAIError(e || "stream error", "upstream_error"),
          id, object: "chat.completion.chunk", created, model, choices: [],
        });
        break;
      }
    }
  } catch (e) {
    failed = true;
    // 客户端主动断开导致的停止不算上游错误 —— 用户切会话、点继续时很常见。
    // 报「截断」会让他以为会话失败，而实际上是他自己切走的。
    const clientGone = res.writableEnded || res.destroyed;
    if (!clientGone) {
      emit({
        ...openAIError(
          // 不要再把真实错误改写成固定文案 —— 上一版把 idle 超时写成
          // "truncated"，导致日志里看不出真实原因，排查方向全错。
          describeStreamError(e, sawFinish, sawAbort),
          "upstream_error"
        ),
        id, object: "chat.completion.chunk", created, model, choices: [],
      });
    }
  }

  // A1: 既没 finish 也没 abort，说明流被截断
  if (!failed && !sawFinish && !sawAbort) {
    // 区分谁先断的：客户端先走是正常中止；上游先走才是真截断。
    const clientGone = res.writableEnded || res.destroyed;
    if (!clientGone) {
      emit({
        ...openAIError("upstream stream truncated before completion", "upstream_error"),
        id, object: "chat.completion.chunk", created, model, choices: [],
      });
    }
    safeEnd(res);
    return;
  }

  if (!failed) safeWrite(res, "data: [DONE]\n\n");
  safeEnd(res);
}

// ══════════════════════════════════════════════════════════
// Anthropic Messages
// ══════════════════════════════════════════════════════════
async function handleAnthropic(req, res) {
  const body = await readBody(req);
  const t = anthropicToWire(body);
  const model = resolveModel(body.model);
  const stream = body.stream === true;

  const abortCh = stream ? makeAbortChannel(res) : null;

  let upstream;
  try {
    upstream = await callUpstream({
      model,
      messages: t.messages,
      system: t.system,
      tools: t.tools.length ? t.tools : undefined,
      maxTokens: t.maxTokens,
      temperature: t.temperature,
      effort: t.effort,
      signal: abortCh?.signal,
      apiKey: resolveApiKey(req),
    });
  } catch (e) {
    abortCh?.cleanup();
    throw e;
  }

  const id = "msg_" + Math.random().toString(36).slice(2, 20);

  const t0 = Date.now();

  if (!stream) {
    const r = await consumeStream(upstream.body);
    logRequest({
      protocol: "anthropic", model, stream: false, status: 200,
      end: "ok",
      in: r.usage?.inputTokens, out: r.usage?.outputTokens,
      reasoning: r.usage?.reasoningTokens, ms: Date.now() - t0,
    });
    return sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model,
      content: wireToAnthropicBlocks(r.content),
      stop_reason: wireToAnthropicStop(r.stopReason, r.content),
      stop_sequence: null,
      usage: wireToAnthropicUsage(r.usage),
    });
  }

  sendSseHeaders(res);
  const emit = (event, data) => {
    safeWrite(res, `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  };

  emit("message_start", {
    message: {
      id, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let blockIndex = -1;
  let openBlock = null; // "text" | "thinking" | "tool_use"
  let sawToolUse = false;
  let sawFinish = false;
  let sawAbort = false;
  let failed = false;

  const closeBlock = () => {
    if (openBlock !== null) {
      emit("content_block_stop", { index: blockIndex });
      openBlock = null;
    }
  };
  const openNew = (type, payload) => {
    closeBlock();
    blockIndex++;
    openBlock = type;
    emit("content_block_start", { index: blockIndex, content_block: payload });
  };

  try {
    for await (const ev of readEvents(upstream.body)) {
      // A4: 客户端断开就停止消费
      if (res.writableEnded || res.destroyed) break;
      if (ev.type === "abort") { sawAbort = true; continue; }
      if (ev.type === "reasoning-delta" && ev.text) {
        if (openBlock !== "thinking") openNew("thinking", { type: "thinking", thinking: "" });
        emit("content_block_delta", { index: blockIndex, delta: { type: "thinking_delta", thinking: ev.text } });
      } else if (ev.type === "text-delta" && ev.text) {
        if (openBlock !== "text") openNew("text", { type: "text", text: "" });
        emit("content_block_delta", { index: blockIndex, delta: { type: "text_delta", text: ev.text } });
      } else if (ev.type === "tool-call") {
        sawToolUse = true;
        openNew("tool_use", {
          type: "tool_use",
          id: ev.toolCallId || "toolu_" + Math.random().toString(36).slice(2, 14),
          name: ev.toolName ?? "",
          input: {},
        });
        emit("content_block_delta", {
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(ev.input ?? {}) },
        });
        closeBlock();
      } else if (ev.type === "finish") {
        sawFinish = true;
        closeBlock();
        const u = ev.totalUsage;
        emit("message_delta", {
          delta: { stop_reason: sawToolUse ? "tool_use" : (ev.finishReason === "length" ? "max_tokens" : "end_turn"), stop_sequence: null },
          usage: wireToAnthropicUsage({
            inputTokens: u?.inputTokens, outputTokens: u?.outputTokens,
            cacheReadTokens: u?.inputTokenDetails?.cacheReadTokens,
            cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens,
            reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? u?.reasoningTokens,
          }),
        });
        emit("message_stop", {});
      } else if (ev.type === "error") {
        // A3: 先把已打开的 content block 关掉，再发 error —— 否则客户端
        // 永远等不到 content_block_stop，界面会卡在"正在输出"。
        failed = true;
        closeBlock();
        const e = typeof ev.error === "string" ? ev.error : ev.error?.message;
        emit("error", anthropicError(e || "stream error", "api_error"));
        break;
      }
    }
  } catch (e) {
    failed = true;
    closeBlock();
    // 客户端主动断开不算上游错误，见 OpenAI 路径同样的处理
    const clientGone = res.writableEnded || res.destroyed;
    if (!clientGone) {
      const msg = describeStreamError(e, sawFinish, sawAbort);
      emit("error", anthropicError(msg, "api_error"));
    }
  }

  // 没有 finish 也没有 abort 时区分谁先断：客户端先走是正常中止
  if (!failed && !sawFinish && !sawAbort) {
    closeBlock();
    const clientGone = res.writableEnded || res.destroyed;
    if (!clientGone) {
      emit("error", anthropicError("upstream stream truncated before completion", "api_error"));
    }
  }
  safeEnd(res);
  abortCh?.cleanup();
}

// ══════════════════════════════════════════════════════════
// OpenAI Responses
// ══════════════════════════════════════════════════════════
async function handleResponses(req, res) {
  const body = await readBody(req);
  if (body.input == null && body.instructions == null) {
    return sendJson(res, 400, openAIError(
      "either 'input' or 'instructions' must be provided", "invalid_request_error"));
  }

  const t = responsesToWire(body);
  const model = resolveModel(body.model);
  const stream = body.stream === true;

  const abortCh = stream ? makeAbortChannel(res) : null;

  let upstream;
  try {
    upstream = await callUpstream({
      model,
      messages: t.messages,
      system: t.system,
      tools: t.tools.length ? t.tools : undefined,
      maxTokens: t.maxTokens,
      temperature: t.temperature,
      effort: t.effort,
      signal: abortCh?.signal,
      apiKey: resolveApiKey(req),
    });
  } catch (e) {
    abortCh?.cleanup();
    throw e;
  }

  const respId = newResponseId();

  const t0 = Date.now();

  if (!stream) {
    const r = await consumeStream(upstream.body);
    const status = r.stopReason === "max_tokens" ? "incomplete" : "completed";
    logRequest({
      protocol: "responses", model, stream: false, status: 200,
      end: "ok",
      in: r.usage?.inputTokens, out: r.usage?.outputTokens,
      reasoning: r.usage?.reasoningTokens, ms: Date.now() - t0,
    });
    return sendJson(res, 200, makeResponseObject({
      id: respId,
      model,
      status,
      output: wireToOutputItems(r.content),
      usage: toResponsesUsage(r.usage),
      incomplete: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    }));
  }

  // ── 流式：按官方事件序列 ──────────────────────────────
  sendSseHeaders(res);
  const nextSeq = createSeq();
  const emit = (type, payload) => {
    safeWrite(res, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: nextSeq(), ...payload })}\n\n`);
  };

  const base = makeResponseObject({ id: respId, model, status: "in_progress", output: [], usage: null });
  emit("response.created", { response: base });
  emit("response.in_progress", { response: { ...base } });

  // 状态跟踪
  let outputIndex = 0;
  let reasoningItem = null;   // { id, index, text }
  let messageItem = null;     // { id, index, text }
  let toolItem = null;        // { id, index, callId, name, args }
  const order = [];           // 按 index 排序的最终 items

  const flushReasoning = () => {
    if (!reasoningItem) return;
    emit("response.reasoning_text.done", {
      item_id: reasoningItem.id, output_index: reasoningItem.index,
      content_index: 0, text: reasoningItem.text,
    });
    emit("response.content_part.done", {
      item_id: reasoningItem.id, output_index: reasoningItem.index, content_index: 0,
      part: { type: "reasoning_text", text: reasoningItem.text },
    });
    emit("response.output_item.done", {
      output_index: reasoningItem.index,
      item: { id: reasoningItem.id, type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: reasoningItem.text }] },
    });
    order.push({
      index: reasoningItem.index,
      item: { id: reasoningItem.id, type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: reasoningItem.text }] },
    });
    reasoningItem = null;
  };

  const flushMessage = () => {
    if (!messageItem) return;
    emit("response.output_text.done", {
      item_id: messageItem.id, output_index: messageItem.index,
      content_index: 0, text: messageItem.text,
    });
    emit("response.content_part.done", {
      item_id: messageItem.id, output_index: messageItem.index, content_index: 0,
      part: { type: "output_text", text: messageItem.text, annotations: [] },
    });
    const item = {
      id: messageItem.id, type: "message", role: "assistant",
      status: "completed", content: [{ type: "output_text", text: messageItem.text, annotations: [] }],
    };
    emit("response.output_item.done", { output_index: messageItem.index, item });
    order.push({ index: messageItem.index, item });
    messageItem = null;
  };

  const flushTool = () => {
    if (!toolItem) return;
    emit("response.function_call_arguments.done", {
      item_id: toolItem.id, output_index: toolItem.index, arguments: toolItem.args,
    });
    const item = {
      id: toolItem.id, type: "function_call", call_id: toolItem.callId,
      name: toolItem.name, arguments: toolItem.args, status: "completed",
    };
    emit("response.output_item.done", { output_index: toolItem.index, item });
    order.push({ index: toolItem.index, item });
    toolItem = null;
  };

  let usage = null;
  let finishReason = null;

  try {
    for await (const ev of readEvents(upstream.body)) {
      if (ev.type === "reasoning-delta" && ev.text) {
        if (!reasoningItem) {
          const idx = outputIndex++;
          reasoningItem = { id: newItemId("rs"), index: idx, text: "" };
          emit("response.output_item.added", {
            output_index: idx,
            item: { id: reasoningItem.id, type: "reasoning", summary: [], content: [] },
          });
          emit("response.content_part.added", {
            item_id: reasoningItem.id, output_index: idx, content_index: 0,
            part: { type: "reasoning_text", text: "" },
          });
        }
        reasoningItem.text += ev.text;
        emit("response.reasoning_text.delta", {
          item_id: reasoningItem.id, output_index: reasoningItem.index,
          content_index: 0, delta: ev.text,
        });
      } else if (ev.type === "text-delta" && ev.text) {
        flushReasoning();
        if (!messageItem) {
          const idx = outputIndex++;
          messageItem = { id: newItemId("msg"), index: idx, text: "" };
          emit("response.output_item.added", {
            output_index: idx,
            item: { id: messageItem.id, type: "message", role: "assistant", status: "in_progress", content: [] },
          });
          emit("response.content_part.added", {
            item_id: messageItem.id, output_index: idx, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        messageItem.text += ev.text;
        emit("response.output_text.delta", {
          item_id: messageItem.id, output_index: messageItem.index,
          content_index: 0, delta: ev.text,
        });
      } else if (ev.type === "tool-call") {
        flushReasoning();
        flushMessage();
        const idx = outputIndex++;
        toolItem = {
          id: newItemId("fc"),
          index: idx,
          callId: ev.toolCallId || "call_" + Math.random().toString(36).slice(2, 12),
          name: ev.toolName ?? "",
          args: JSON.stringify(ev.input ?? {}),
        };
        emit("response.output_item.added", {
          output_index: idx,
          item: { id: toolItem.id, type: "function_call", call_id: toolItem.callId, name: toolItem.name, arguments: "", status: "in_progress" },
        });
        emit("response.function_call_arguments.delta", {
          item_id: toolItem.id, output_index: idx, delta: toolItem.args,
        });
        flushTool();
      } else if (ev.type === "finish") {
        usage = ev.totalUsage;
        finishReason = ev.finishReason;
      } else if (ev.type === "error") {
        const msg = typeof ev.error === "string" ? ev.error : ev.error?.message;
        emit("response.failed", {
          response: makeResponseObject({
            id: respId, model, status: "failed", output: [],
            error: { code: "upstream_error", message: msg || "stream error" },
          }),
        });
        safeEnd(res);
        return;
      }
    }
  } catch (e) {
    // 客户端主动断开不算上游错误；否则用户切会话时会看到 response.failed
    const clientGone = res.writableEnded || res.destroyed;
    if (!clientGone) {
      emit("response.failed", {
        response: makeResponseObject({
          id: respId, model, status: "failed", output: [],
          error: { code: "upstream_error", message: e.message },
        }),
      });
    }
    safeEnd(res);
    return;
  }

  flushReasoning();
  flushMessage();
  flushTool();

  order.sort((a, b) => a.index - b.index);
  const status = finishReason === "length" ? "incomplete" : "completed";

  emit(status === "incomplete" ? "response.incomplete" : "response.completed", {
    response: makeResponseObject({
      id: respId,
      model,
      status,
      output: order.map((o) => o.item),
      usage: toResponsesUsage({
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
        reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens,
      }),
      incomplete: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    }),
  });
  safeEnd(res);
}

// ══════════════════════════════════════════════════════════
// 直通事件解析（避免重复 JSON.parse）
// ══════════════════════════════════════════════════════════
// 两段超时要分开：
//   FIRST_EVENT_MS —— 从发出请求到第一个事件。上游要先处理整个上下文，
//     1M token 的会话等几分钟很正常，用 idle 阈值去卡它必然误杀。
//   IDLE_TIMEOUT_MS —— 已经收到过事件之后的间隔。这时才真的说明上游卡住了。
const FIRST_EVENT_MS = Number(argOf("--first-event-timeout", "600000"));
const IDLE_TIMEOUT_MS = Number(argOf("--idle-timeout", "180000"));

/**
 * 逐行产出上游 NDJSON 事件。
 *
 * fetchWithTimeout 的超时只覆盖到响应头，headers 到达后就没有任何时限了。
 * 上游「发一半静默」会让请求永久挂起，所以这里加 idle 超时：
 * 超过 IDLE_TIMEOUT_MS 没有新数据就判定卡死并抛错。
 */
async function* readEvents(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  let gotAny = false;
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    const nextPromise = iterator.next();
    // 首事件和后续事件的容忍度不同：首事件要等上游处理完整个上下文，
    // 后续事件之间才该用较短的 idle 阈值。
    const limit = gotAny ? IDLE_TIMEOUT_MS : FIRST_EVENT_MS;
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        rej(Object.assign(
          new Error(gotAny
            ? `upstream idle for ${limit}ms after first event`
            : `upstream sent no data for ${limit}ms`),
          { status: 504, retryable: true, midStream: gotAny }
        ));
      }, limit);
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
    gotAny = true;
    const chunk = step.value;
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      const line2 = line.trim();
      if (!line2) continue;
      try { yield JSON.parse(line2); } catch { }
    }
  }
  const tail = buf.trim();
  if (tail) { try { yield JSON.parse(tail); } catch { } }
}

// ══════════════════════════════════════════════════════════
// 端点
// ══════════════════════════════════════════════════════════
function handleModels(res) {
  const data = Object.entries(MODEL_META).map(([id, m]) => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "deepseek",
    name: m.name,
    context_window: m.ctx,
    max_output_tokens: 64000,
    input_modalities: m.vision ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
    effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
  }));
  sendJson(res, 200, { object: "list", data });
}

// 额度结构依据官方 CLI 的 projectUsageView：
//   credits.data.credits.monthlyCredits / purchasedCredits / freeCredits
//   credits.data.windowLimits.fiveHour {used, cap, resetAt}
//   credits.data.windowLimits.weekly  {used, cap, resetAt}
//   subscription.data.planId / status / currentPeriodEnd
async function fetchUsage() {
  const apiKey = readApiKey();
  const { traceId, spanId } = generateTraceIds();
  const headers = buildHeaders({ authKey: apiKey, cliVersion: CLI_VERSION, traceId, spanId });

  const get = async (route) => {
    const r = await fetchWithTimeout(API_BASE + route, { method: "GET", headers }, 15000);
    if (!r.ok) throw new Error(`${route} -> HTTP ${r.status}`);
    return r.json();
  };

  // credits / subscriptions 各自独立，任一失败不影响另一个
  const [credits, subscription] = await Promise.all([
    get(ROUTE_CREDITS).catch((e) => ({ __error: e.message })),
    get(ROUTE_SUBSCRIPTIONS).catch((e) => ({ __error: e.message })),
  ]);
  return { credits, subscription };
}

/** 归一成统一的窗口结构 */
function normalizeWindows(creditsData) {
  const c = creditsData?.credits || creditsData?.data?.credits || {};
  const wl = c.windowLimits || creditsData?.windowLimits || {};

  const win = (w, label) => {
    if (!w) return null;
    const used = Number(w.used ?? 0);
    const cap = Number(w.cap ?? w.limit ?? 0);
    return {
      label,
      used,
      cap,
      left: Math.max(0, cap - used),
      percent: cap > 0 ? Math.round((used / cap) * 100) : 0,
      reset_at: w.resetAt ?? w.reset_at ?? null,
    };
  };

  return {
    five_hour: win(wl.fiveHour ?? wl.five_hour, "5-hour"),
    weekly: win(wl.weekly, "weekly"),
    monthly_credits: Number(c.monthlyCredits ?? 0),
    purchased_credits: Number(c.purchasedCredits ?? 0),
    free_credits: Number(c.freeCredits ?? 0),
    plan_id: c.planId ?? creditsData?.planId ?? null,
  };
}

async function handleBalance(res) {
  try {
    const { credits, subscription } = await fetchUsage();
    const w = normalizeWindows(credits);
    const total = w.monthly_credits + w.purchased_credits + w.free_credits;

    // 官方 /user/balance 是「账户余额」（按量付费语义）。
    // 本项目背后是订阅制套餐，没有可充值余额 —— 这里返回的是
    // 「套餐周期内剩余额度」，语义相近但不完全等价。
    // 客户端应把它当作「还能用多少」，而不是「能退多少」。
    sendJson(res, 200, {
      is_available: true,
      balance_infos: [{
        currency: "USD",
        total_balance: total.toFixed(2),
        granted_balance: (w.monthly_credits + w.free_credits).toFixed(2),
        topped_up_balance: w.purchased_credits.toFixed(2),
      }],
    });
  } catch (e) {
    sendJson(res, 502, openAIError("usage fetch failed: " + e.message, "upstream_error"));
  }
}

/** 更实用的额度视图（面板/自检用），形状是本项目自己的 */
async function handleQuota(res) {
  try {
    const { credits, subscription } = await fetchUsage();
    const w = normalizeWindows(credits);
    const sub = subscription?.data ?? subscription ?? {};
    sendJson(res, 200, {
      plan_id: sub.planId ?? w.plan_id,
      status: sub.status ?? null,
      current_period_end: sub.currentPeriodEnd ?? null,
      credits: {
        monthly: w.monthly_credits,
        purchased: w.purchased_credits,
        free: w.free_credits,
        total: w.monthly_credits + w.purchased_credits + w.free_credits,
      },
      windows: {
        five_hour: w.five_hour,
        weekly: w.weekly,
      },
      raw_errors: {
        credits: credits?.__error ?? null,
        subscription: subscription?.__error ?? null,
      },
    });
  } catch (e) {
    sendJson(res, 502, openAIError("usage fetch failed: " + e.message, "upstream_error"));
  }
}

// ══════════════════════════════════════════════════════════
// 路由
// ══════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") {
    if (!ALLOW_CORS) return res.writeHead(405).end();
    return res.writeHead(204).end();
  }

  const url = (req.url || "").split("?")[0];

  try {
    if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
      return sendJson(res, 200, { status: "ok", version: GATEWAY_VERSION, endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"] });
    }
    if (req.method === "GET" && url === "/v1/models") return handleModels(res);
    if (req.method === "GET" && (url === "/user/balance" || url === "/v1/user/balance")) return await handleBalance(res);
    if (req.method === "GET" && (url === "/user/quota" || url === "/v1/user/quota")) return await handleQuota(res);
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) return await handleOpenAI(req, res);
    if (req.method === "POST" && (url === "/v1/messages" || url === "/messages")) return await handleAnthropic(req, res);
    if (req.method === "POST" && (url === "/v1/responses" || url === "/responses")) return await handleResponses(req, res);

    sendJson(res, 404, openAIError(`No route for ${req.method} ${url}`, "not_found_error"));
  } catch (e) {
    log("handler error:", e.message);
    if (res.headersSent) {
      safeEnd(res);
      return;
    }
    const status = e.status || 502;
    if ((req.url || "").includes("/messages")) {
      sendJson(res, status, anthropicError(e.message, status === 400 ? "invalid_request_error" : "api_error"));
    } else {
      sendJson(res, status, openAIError(e.message, e.status === 400 ? "invalid_request_error" : "upstream_error", e.code));
    }
  }
});

// 单进程网关崩了就全停了，这里兜住最后一道。
// 记录后继续运行：单次请求出错不该带走整个服务。
process.on("unhandledRejection", (reason) => {
  log("unhandledRejection: " + (reason && reason.stack ? reason.stack : String(reason)));
});
process.on("uncaughtException", (err) => {
  log("uncaughtException: " + (err && err.stack ? err.stack : String(err)));
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    logError(`端口 ${PORT} 已被占用`);
  } else {
    logError(e.message);
  }
  process.exit(1);
});

// B7: 绑到 0.0.0.0 时任何能连到端口的人都能免费用本账号的上游额度。
// 这不是错误（用户可能有正当需求），但必须让人看见。
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK.has(HOST)) {
  console.warn("");
  console.warn("  ! 警告：网关绑定在 " + HOST + "，不是回环地址。");
  console.warn("    任何能访问该地址的人都会消耗本账号的 Command Code 额度。");
  console.warn("    如非必要请改回 127.0.0.1。");
  console.warn("");
}

// 启动时拉一次模型列表；失败不影响启动，用回落值
refreshModelMeta().catch(() => { });

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log("  POST /v1/chat/completions   (OpenAI)");
  log("  POST /v1/messages           (Anthropic)");
  log("  POST /v1/responses          (Responses)");
  log("  GET  /v1/models");
  log("  GET  /user/balance");
  log("  GET  /user/quota");
  log("upstream: " + API_BASE);
});
