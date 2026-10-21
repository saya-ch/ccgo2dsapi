// responses-server.mjs —— /v1/responses 端点
//
// 官方规范：https://api-docs.deepseek.com/zh-cn/guides/responses_api
//
// 设计：这不是独立的反代，而是一个薄适配层。它把 Responses 请求翻译成
// Chat Completions 请求，转发给同项目的 8787 代理，再把返回翻译成
// Responses 的事件序列。好处是上游协议、鉴权、重试、额度统计全部复用，
// 只需要维护协议形状这一层。
//
// 用法：
//   node tools/responses-server.mjs [--port 8788] [--upstream http://127.0.0.1:8787]
import http from "node:http";
import {
  toCCMessagesFromInput,
  toCCToolsFromResponses,
  resolveToolChoice,
  resolveEffort,
  nextSeq,
  resetSeq,
  newResponseId,
  newItemId,
  toResponsesUsage,
} from "./responses.js";

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(argOf("--port", "8788"));
const HOST = argOf("--host", "127.0.0.1");
const UPSTREAM = argOf("--upstream", "http://127.0.0.1:8787");
const API_KEY = argOf("--key", "proxy-managed");

function log(msg, extra) {
  const line = `[responses] ${msg}`;
  if (extra) console.log(line, JSON.stringify(extra));
  else console.log(line);
}

// ── 把 Responses 请求转成 Chat Completions 请求 ─────────────
function toChatRequest(body) {
  const { ccMessages, systemPrompt } = toCCMessagesFromInput(body.input, body.instructions);

  // 转回 OpenAI messages 形状（上游代理认这个）
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const m of ccMessages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      // 上游 tool-call 形状在 chat/completions 里是 tool_calls
      const toolCalls = m.content
        .filter((p) => p.type === "tool-call")
        .map((p) => ({
          id: p.toolCallId,
          type: "function",
          function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) },
        }));
      const textPart = m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
      const msg = { role: "assistant", content: textPart || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    if (m.role === "tool") {
      const r = m.content[0];
      messages.push({
        role: "tool",
        tool_call_id: r.toolCallId,
        content: r.output?.value ?? "",
      });
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }

  const out = {
    model: body.model,
    messages,
    max_tokens: body.max_output_tokens ?? 4096,
    stream: body.stream === true,
  };

  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;

  const tools = toCCToolsFromResponses(body.tools);
  if (tools) {
    out.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  const tc = resolveToolChoice(body.tool_choice);
  if (tc) out.tool_choice = tc.type === "tool" ? { type: "function", function: { name: tc.name } } : "auto";

  const effort = resolveEffort(body.reasoning);
  if (effort) out.reasoning_effort = effort;

  // text.format → response_format
  const fmt = body.text?.format;
  if (fmt && fmt.type === "json_object") out.response_format = { type: "json_object" };
  else if (fmt && fmt.type === "json_schema") {
    out.response_format = {
      type: "json_schema",
      json_schema: { name: fmt.name ?? "output", schema: fmt.schema, strict: fmt.strict ?? false },
    };
  }

  return out;
}

// ── 构造响应对象 ──────────────────────────────────────────
function makeResponseObj({ id, model, status, output, usage, error, incomplete }) {
  const obj = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    error: error ?? null,
    incomplete_details: incomplete ?? null,
    usage: usage ?? null,
    store: false,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };
  return obj;
}

// ── 非流式 ────────────────────────────────────────────────
async function handleNonStream(body, res) {
  const chatReq = toChatRequest(body);
  const respId = newResponseId();

  let upstreamRes;
  try {
    upstreamRes = await fetch(UPSTREAM + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(chatReq),
    });
  } catch (e) {
    return sendError(res, 502, "upstream_unreachable", e.message);
  }

  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message ?? text; } catch { }
    return sendError(res, upstreamRes.status, "upstream_error", msg);
  }

  let chat;
  try { chat = JSON.parse(text); } catch {
    return sendError(res, 502, "bad_upstream_body", text.slice(0, 200));
  }

  const choice = chat.choices?.[0];
  const output = [];

  // reasoning item
  const rc = choice?.message?.reasoning_content;
  if (rc) {
    output.push({
      id: newItemId("rs"),
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: rc }],
    });
  }

  // message item
  const content = choice?.message?.content;
  if (content) {
    output.push({
      id: newItemId("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content, annotations: [] }],
    });
  }

  // function_call items
  for (const tc of choice?.message?.tool_calls ?? []) {
    output.push({
      id: newItemId("fc"),
      type: "function_call",
      call_id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments ?? "{}",
      status: "completed",
    });
  }

  const status = choice?.finish_reason === "length" ? "incomplete" : "completed";
  const obj = makeResponseObj({
    id: respId,
    model: body.model,
    status,
    output,
    usage: toResponsesUsage({
      promptTokens: chat.usage?.prompt_tokens,
      completionTokens: chat.usage?.completion_tokens,
      totalTokens: chat.usage?.total_tokens,
      promptTokensDetails: chat.usage?.prompt_tokens_details,
      completionTokensDetails: chat.usage?.completion_tokens_details,
    }),
    incomplete: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  });

  sendJson(res, 200, obj);
}

// ── 流式 ──────────────────────────────────────────────────
async function handleStream(body, res) {
  const chatReq = toChatRequest(body);
  chatReq.stream = true;
  chatReq.stream_options = { include_usage: true };

  const respId = newResponseId();
  resetSeq();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const emit = (type, payload) => {
    const ev = { type, sequence_number: nextSeq(), ...payload };
    res.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };

  // response.created
  const baseObj = makeResponseObj({ id: respId, model: body.model, status: "in_progress", output: [], usage: null });
  emit("response.created", { response: baseObj });
  emit("response.in_progress", { response: { ...baseObj } });

  let upstreamRes;
  try {
    upstreamRes = await fetch(UPSTREAM + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(chatReq),
    });
  } catch (e) {
    emit("response.failed", {
      response: makeResponseObj({
        id: respId, model: body.model, status: "failed", output: [],
        error: { code: "upstream_unreachable", message: e.message },
      }),
    });
    return res.end();
  }

  if (!upstreamRes.ok) {
    const t = await upstreamRes.text();
    let msg = t;
    try { msg = JSON.parse(t).error?.message ?? t; } catch { }
    emit("response.failed", {
      response: makeResponseObj({
        id: respId, model: body.model, status: "failed", output: [],
        error: { code: "upstream_error", message: msg },
      }),
    });
    return res.end();
  }

  // 解析上游 SSE，转成 Responses 事件
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  // 状态跟踪
  let reasoningItem = null;
  let reasoningText = "";
  let messageItem = null;
  let messageText = "";
  const toolItems = new Map(); // index -> { id, itemId, name, args }
  let usage = null;
  let finishReason = null;

  const flushReasoningDone = () => {
    if (!reasoningItem) return;
    emit("response.reasoning_text.done", {
      item_id: reasoningItem.id,
      output_index: reasoningItem.__idx,
      content_index: 0,
      text: reasoningText,
    });
    emit("response.content_part.done", {
      item_id: reasoningItem.id,
      output_index: reasoningItem.__idx,
      content_index: 0,
      part: { type: "reasoning_text", text: reasoningText },
    });
    emit("response.output_item.done", { output_index: reasoningItem.__idx, item: stripIdx(reasoningItem) });
  };

  const flushMessageDone = () => {
    if (!messageItem) return;
    emit("response.output_text.done", {
      item_id: messageItem.id,
      output_index: messageItem.__idx,
      content_index: 0,
      text: messageText,
    });
    emit("response.content_part.done", {
      item_id: messageItem.id,
      output_index: messageItem.__idx,
      content_index: 0,
      part: { type: "output_text", text: messageText, annotations: [] },
    });
    emit("response.output_item.done", { output_index: messageItem.__idx, item: stripIdx(messageItem) });
  };

  const stripIdx = (it) => {
    const { __idx, ...rest } = it;
    return rest;
  };

  const outputItems = [];
  let nextIndex = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const raw of lines) {
      const s = raw.trim();
      if (!s.startsWith("data:")) continue;
      const p = s.slice(5).trim();
      if (p === "[DONE]") continue;
      let j;
      try { j = JSON.parse(p); } catch { continue; }

      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      const d = ch.delta;
      if (!d) continue;

      // 思考增量
      if (d.reasoning_content) {
        if (!reasoningItem) {
          reasoningItem = { id: newItemId("rs"), type: "reasoning", summary: [], content: [], __idx: nextIndex++ };
          emit("response.output_item.added", { output_index: reasoningItem.__idx, item: { ...stripIdx(reasoningItem), content: [] } });
          emit("response.content_part.added", {
            item_id: reasoningItem.id, output_index: reasoningItem.__idx, content_index: 0,
            part: { type: "reasoning_text", text: "" },
          });
        }
        reasoningText += d.reasoning_content;
        emit("response.reasoning_text.delta", {
          item_id: reasoningItem.id, output_index: reasoningItem.__idx, content_index: 0,
          delta: d.reasoning_content,
        });
      }

      // 正文增量
      if (d.content) {
        if (!messageItem) {
          flushReasoningDone();
          messageItem = { id: newItemId("msg"), type: "message", role: "assistant", status: "in_progress", content: [], __idx: nextIndex++ };
          emit("response.output_item.added", { output_index: messageItem.__idx, item: { ...stripIdx(messageItem), content: [] } });
          emit("response.content_part.added", {
            item_id: messageItem.id, output_index: messageItem.__idx, content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        messageText += d.content;
        emit("response.output_text.delta", {
          item_id: messageItem.id, output_index: messageItem.__idx, content_index: 0,
          delta: d.content,
        });
      }

      // 工具调用
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let st = toolItems.get(idx);
        if (!st) {
          flushReasoningDone();
          flushMessageDone();
          st = {
            callId: tc.id ?? newItemId("call"),
            itemId: newItemId("fc"),
            name: tc.function?.name ?? "",
            args: "",
            index: nextIndex++,
          };
          toolItems.set(idx, st);
          emit("response.output_item.added", {
            output_index: st.index,
            item: { id: st.itemId, type: "function_call", call_id: st.callId, name: st.name, arguments: "", status: "in_progress" },
          });
        }
        if (tc.function?.name && !st.name) st.name = tc.function.name;
        const frag = tc.function?.arguments ?? "";
        if (frag) {
          st.args += frag;
          emit("response.function_call_arguments.delta", {
            item_id: st.itemId, output_index: st.index, delta: frag,
          });
        }
      }
    }
  }

  // 收尾
  flushReasoningDone();
  flushMessageDone();

  for (const st of toolItems.values()) {
    emit("response.function_call_arguments.done", {
      item_id: st.itemId, output_index: st.index, arguments: st.args,
    });
    emit("response.output_item.done", {
      output_index: st.index,
      item: { id: st.itemId, type: "function_call", call_id: st.callId, name: st.name, arguments: st.args, status: "completed" },
    });
  }

  // 汇总 output
  if (reasoningItem) outputItems.push({ id: reasoningItem.id, type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: reasoningText }] });
  if (messageItem) outputItems.push({ id: messageItem.id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: messageText, annotations: [] }] });
  for (const st of toolItems.values()) {
    outputItems.push({ id: st.itemId, type: "function_call", call_id: st.callId, name: st.name, arguments: st.args, status: "completed" });
  }

  const status = finishReason === "length" ? "incomplete" : "completed";
  const finalObj = makeResponseObj({
    id: respId,
    model: body.model,
    status,
    output: outputItems,
    usage: toResponsesUsage({
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      totalTokens: usage?.total_tokens,
      promptTokensDetails: usage?.prompt_tokens_details,
      completionTokensDetails: usage?.completion_tokens_details,
    }),
    incomplete: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  });

  emit(status === "incomplete" ? "response.incomplete" : "response.completed", { response: finalObj });
  res.end();
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { message, type: "invalid_request_error", param: null, code } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try { resolve(JSON.parse(d || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ── 路由 ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    return res.end();
  }

  const url = (req.url || "").split("?")[0];

  if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
    return sendJson(res, 200, { status: "ok", service: "responses", upstream: UPSTREAM });
  }

  if (req.method === "GET" && url === "/v1/responses") {
    return sendJson(res, 200, { object: "list", data: [] });
  }

  if (req.method === "POST" && url === "/v1/responses") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendError(res, 400, "invalid_json", "Request body is not valid JSON");
    }
    // 官方：input 与 instructions 至少传一个
    if (body.input == null && body.instructions == null) {
      return sendError(res, 400, "invalid_request_error", "either 'input' or 'instructions' must be provided");
    }
    try {
      if (body.stream === true) await handleStream(body, res);
      else await handleNonStream(body, res);
    } catch (e) {
      log("handler error: " + e.message);
      if (!res.headersSent) sendError(res, 502, "internal_error", e.message);
      else res.end();
    }
    return;
  }

  sendError(res, 404, "not_found", `No route for ${req.method} ${url}`);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}/v1/responses`);
  log(`upstream: ${UPSTREAM}`);
});
