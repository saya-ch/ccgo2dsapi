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

import {
  buildHeaders, buildGenerateBody, toWireTools, toWireSystem, toWireMessages,
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
const API_KEY_SENTINEL = argOf("--sentinel", "proxy-managed");
const MAX_BODY = 48 * 1024 * 1024;
const TIMEOUT_MS = Number(argOf("--timeout", "600000"));
const ALLOW_CORS = args.includes("--cors");
const LOG_LEVEL = argOf("--log-level", "info");

function log(...a) {
  if (LOG_LEVEL !== "silent") console.log("[gateway]", ...a);
}

// ── 鉴权：从 auth.json 读真实 key ─────────────────────────
let cachedKey = null;
function readApiKey() {
  if (cachedKey && process.env.CCGO_NO_CACHE) return cachedKey;
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

async function callUpstream({ model, messages, system, tools, maxTokens, temperature, effort, signal }) {
  const apiKey = readApiKey();
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

  const res = await fetchWithTimeout(
    API_BASE + ROUTE_GENERATE,
    { method: "POST", headers, body: JSON.stringify(body), signal },
    TIMEOUT_MS
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text;
    let code = null;
    try {
      const j = JSON.parse(text);
      msg = j.error?.message || j.message || text;
      code = j.error?.code || null;
    } catch { }
    const err = new Error(msg.slice(0, 500));
    err.status = res.status;
    err.code = code;
    err.retryable = isRetryableStatus(res.status) && !hasTerminalMarker(msg);
    throw err;
  }

  return res;
}

// ── HTTP 工具 ─────────────────────────────────────────────
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
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(Object.assign(new Error("invalid json"), { status: 400 }));
      }
    });
    req.on("error", reject);
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
  if (!m) return "deepseek/deepseek-v4.1-flash";
  if (m.includes("/")) return m;
  const k = m.toLowerCase();
  if (MODEL_ALIASES[k]) return MODEL_ALIASES[k];
  // Anthropic 官方语义：claude-opus* -> pro，sonnet/haiku/fable/其它 claude* -> flash
  if (k.startsWith("claude")) {
    if (k.includes("opus")) return "deepseek/deepseek-v4-pro";
    return "deepseek/deepseek-v4.1-flash";
  }
  return m;
}

// ── 模型元数据（实测值）───────────────────────────────────
const MODEL_META = {
  "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", ctx: 1000000, vision: true },
  "deepseek/deepseek-v4.1-flash-fast": { name: "DeepSeek V4.1 Flash Fast", ctx: 1000000, vision: true },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", ctx: 1000000, vision: false },
  "deepseek/deepseek-v4-flash-fast": { name: "DeepSeek V4 Flash Fast", ctx: 1000000, vision: false },
  "deepseek/deepseek-v4-flash-vision-exp": { name: "DeepSeek V4 Flash Vision (exp)", ctx: 1000000, vision: true },
  "deepseek/deepseek-v4-pro": { name: "DeepSeek V4 Pro", ctx: 1000000, vision: false },
};

// ══════════════════════════════════════════════════════════
// OpenAI Chat Completions
// ══════════════════════════════════════════════════════════
async function handleOpenAI(req, res) {
  const body = await readBody(req);
  const t = openAIToWire(body);
  const model = resolveModel(body.model);
  const stream = body.stream === true;

  const upstream = await callUpstream({
    model,
    messages: t.messages,
    system: t.system,
    tools: t.tools.length ? t.tools : undefined,
    maxTokens: t.maxTokens,
    temperature: t.temperature,
    // 官方 DeepSeek 默认开启思考模式；未显式指定时给 high
    effort: t.effort === undefined ? "high" : t.effort,
  });

  const id = "chatcmpl-" + Math.random().toString(36).slice(2, 14);
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const r = await consumeStream(upstream.body);
    const message = wireToOpenAIMessage(r.content);
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
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = (delta, finish = null) => ({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  emit(chunk({ role: "assistant", content: "" }));

  let sawToolUse = false;
  let toolIndex = 0;
  let pendingToolName = null;
  let pendingArgs = "";

  try {
    for await (const ev of readEvents(upstream.body)) {
      if (ev.type === "text-delta" && ev.text) {
        emit(chunk({ content: ev.text }));
      } else if (ev.type === "reasoning-delta" && ev.text) {
        emit(chunk({ reasoning_content: ev.text }));
      } else if (ev.type === "tool-call") {
        sawToolUse = true;
        const args = JSON.stringify(ev.input ?? {});
        emit(chunk({
          tool_calls: [{
            index: toolIndex++,
            id: ev.toolCallId || "call_" + Math.random().toString(36).slice(2, 10),
            type: "function",
            function: { name: ev.toolName ?? "", arguments: args },
          }],
        }));
      } else if (ev.type === "finish") {
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
      } else if (ev.type === "error") {
        const e = typeof ev.error === "string" ? ev.error : ev.error?.message;
        emit(openAIError(e || "stream error", "upstream_error"));
      }
    }
  } catch (e) {
    emit(openAIError(e.message, "upstream_error"));
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

// ══════════════════════════════════════════════════════════
// Anthropic Messages
// ══════════════════════════════════════════════════════════
async function handleAnthropic(req, res) {
  const body = await readBody(req);
  const t = anthropicToWire(body);
  const model = resolveModel(body.model);
  const stream = body.stream === true;

  const upstream = await callUpstream({
    model,
    messages: t.messages,
    system: t.system,
    tools: t.tools.length ? t.tools : undefined,
    maxTokens: t.maxTokens,
    temperature: t.temperature,
    effort: t.effort,
  });

  const id = "msg_" + Math.random().toString(36).slice(2, 20);

  if (!stream) {
    const r = await consumeStream(upstream.body);
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
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
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
        const e = typeof ev.error === "string" ? ev.error : ev.error?.message;
        emit("error", anthropicError(e || "stream error", "api_error").error
          ? anthropicError(e || "stream error", "api_error") : {});
      }
    }
  } catch (e) {
    emit("error", anthropicError(e.message, "api_error"));
  }
  res.end();
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

  const upstream = await callUpstream({
    model,
    messages: t.messages,
    system: t.system,
    tools: t.tools.length ? t.tools : undefined,
    maxTokens: t.maxTokens,
    temperature: t.temperature,
    effort: t.effort,
  });

  const respId = newResponseId();

  if (!stream) {
    const r = await consumeStream(upstream.body);
    const status = r.stopReason === "max_tokens" ? "incomplete" : "completed";
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
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: nextSeq(), ...payload })}\n\n`);
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
        res.end();
        return;
      }
    }
  } catch (e) {
    emit("response.failed", {
      response: makeResponseObject({
        id: respId, model, status: "failed", output: [],
        error: { code: "upstream_error", message: e.message },
      }),
    });
    res.end();
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
  res.end();
}

// ══════════════════════════════════════════════════════════
// 直通事件解析（避免重复 JSON.parse）
// ══════════════════════════════════════════════════════════
async function* readEvents(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try { yield JSON.parse(s); } catch { }
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

async function handleBalance(res) {
  const apiKey = readApiKey();
  const { traceId, spanId } = generateTraceIds();
  const headers = buildHeaders({ authKey: apiKey, cliVersion: CLI_VERSION, traceId, spanId });
  try {
    const r = await fetchWithTimeout(API_BASE + ROUTE_CREDITS, { method: "GET", headers }, 15000);
    const j = await r.json();
    // 官方 /user/balance 形状
    const windows = j.windows || j;
    const pick = (k) => {
      const w = windows[k];
      return w ? { used: w.used ?? 0, total: w.limit ?? w.total ?? 0 } : null;
    };
    const fiveHour = pick("fiveHour") || pick("5h");
    const monthly = pick("monthly") || pick("month");
    sendJson(res, 200, {
      is_available: true,
      balance_infos: [{
        currency: "USD",
        total_balance: String(monthly?.total ?? 0),
        granted_balance: String(monthly?.total ?? 0),
        topped_up_balance: "0",
      }],
      raw: j,
    });
  } catch (e) {
    sendJson(res, 502, openAIError("upstream credits fetch failed: " + e.message, "upstream_error"));
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
      return sendJson(res, 200, { status: "ok", version: "1.0.0", endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"] });
    }
    if (req.method === "GET" && url === "/v1/models") return handleModels(res);
    if (req.method === "GET" && (url === "/user/balance" || url === "/v1/user/balance")) return await handleBalance(res);
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) return await handleOpenAI(req, res);
    if (req.method === "POST" && (url === "/v1/messages" || url === "/messages")) return await handleAnthropic(req, res);
    if (req.method === "POST" && (url === "/v1/responses" || url === "/responses")) return await handleResponses(req, res);

    sendJson(res, 404, openAIError(`No route for ${req.method} ${url}`, "not_found_error"));
  } catch (e) {
    log("handler error:", e.message);
    if (res.headersSent) {
      res.end();
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

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[gateway] 端口 ${PORT} 已被占用`);
  } else {
    console.error(`[gateway] ${e.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[gateway] listening on http://${HOST}:${PORT}`);
  console.log(`[gateway]   POST /v1/chat/completions   (OpenAI)`);
  console.log(`[gateway]   POST /v1/messages           (Anthropic)`);
  console.log(`[gateway]   POST /v1/responses          (Responses)`);
  console.log(`[gateway]   GET  /v1/models`);
  console.log(`[gateway]   GET  /user/balance`);
  console.log(`[gateway] upstream: ${API_BASE}`);
});
