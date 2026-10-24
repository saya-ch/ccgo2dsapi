// responses.mjs —— OpenAI Responses 协议 ↔ wire
//
// 复用 wire.mjs 的 messages/tools 结构；本文件只做 Responses 特有的形状转换。
// 规格：https://api-docs.deepseek.com/zh-cn/guides/responses_api

import { wireToOpenAIUsage } from "./translate.mjs";

// ── 请求：input items → wire messages ────────────────────
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // summary_text 是 reasoning.summary 里用的类型 —— 漏掉它会让历史思维链
  // 静默变成空字符串，看起来像「成功回传了但内容为空」。
  return content
    .filter((p) => p && (
      p.type === "input_text" ||
      p.type === "output_text" ||
      p.type === "text" ||
      p.type === "summary_text"
    ))
    .map((p) => p.text ?? "")
    .join("");
}

function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (p && p.type === "input_image") {
      const url = p.image_url ?? p.file_id ?? "";
      if (url) {
        // 只从 data URL 提取；http(s) 或无扩展名时省略，让上游判断
        const mime = /^data:([^;]+);/.exec(url)?.[1];
        out.push({ type: "image", image: url, ...(mime ? { mimeType: mime } : {}) });
      }
    }
  }
  return out;
}

export function responsesToWire(body) {
  const systemParts = [];
  const messages = [];
  const toolNames = new Map();
  // reasoning 项与后续的 assistant/tool-call 可能分成多个 item 到达，
  // 先攒着，附加到下一个 assistant 消息上。
  const pendingReasoning = [];
  // 与另外两套协议一致：只有带 tools 时，历史 reasoning 才会被上游拼进上下文
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (typeof body.instructions === "string" && body.instructions) {
    systemParts.push(body.instructions);
  }

  const items = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input }]
    : Array.isArray(body.input) ? body.input : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const t = item.type;

    if (!t || t === "message") {
      const role = item.role ?? "user";
      const text = textOf(item.content);
      const imgs = imagesOf(item.content);

      if (role === "system" || role === "developer") {
        if (text) systemParts.push(text);
        continue;
      }
      if (role === "assistant") {
        const parts = [];
        if (pendingReasoning.length) {
          parts.push({ type: "reasoning", text: pendingReasoning.join("") });
          pendingReasoning.length = 0;
        }
        if (text) parts.push({ type: "text", text });
        if (parts.length > 0) messages.push({ role: "assistant", content: parts });
        continue;
      }
      const parts = [];
      if (text) parts.push({ type: "text", text });
      parts.push(...imgs);
      if (parts.length > 0) messages.push({ role: "user", content: parts });
      continue;
    }

    if (t === "function_call" || t === "custom_tool_call") {
      const id = item.call_id ?? item.id ?? "";
      const name = item.name ?? "";
      let args = item.arguments ?? item.input ?? "{}";
      let parsed;
      try { parsed = typeof args === "string" ? JSON.parse(args) : args; } catch { parsed = {}; }
      toolNames.set(id, name);
      const parts = [];
      if (pendingReasoning.length) {
        parts.push({ type: "reasoning", text: pendingReasoning.join("") });
        pendingReasoning.length = 0;
      }
      parts.push({ type: "tool-call", toolCallId: id, toolName: name, input: parsed });
      messages.push({ role: "assistant", content: parts });
      continue;
    }

    if (t === "function_call_output" || t === "custom_tool_call_output") {
      const id = item.call_id ?? "";
      let out = item.output;
      if (Array.isArray(out)) out = textOf(out);
      if (typeof out !== "string") out = JSON.stringify(out ?? "");
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: id,
          toolName: toolNames.get(id) ?? "unknown",
          output: { type: "text", value: out },
        }],
      });
      continue;
    }
    // reasoning 项：官方语义要求带 tools 时回传历史思维链，
    // 否则模型看不到自己上一轮怎么想的，会反复重新推理。
    if (t === "reasoning") {
      if (hasTools) {
        const txt = item.summary ? textOf(item.summary) : (item.content ? textOf(item.content) : "");
        if (txt) pendingReasoning.push(txt);
      }
      continue;
    }
    // web_search_call 等其余类型仍按官方语义忽略
  }

  return {
    messages,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    tools: toWireToolsFromResponses(body.tools),
    // Responses 的 max_output_tokens 同样受上游 200000 限制
    maxTokens: (() => {
      const n = Number(body.max_output_tokens);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      return Math.min(Math.floor(n), 200000);
    })(),
    temperature: body.temperature,
    effort: responsesEffort(body.reasoning),
    toolChoice: body.tool_choice,
  };
}

function toWireToolsFromResponses(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === "function") {
      out.push({
        name: t.name,
        description: t.description,
        input_schema: t.parameters ?? { type: "object", properties: {} },
      });
    } else if (t.type === "custom" && t.name === "apply_patch") {
      out.push({
        name: "apply_patch",
        description: t.description ?? "Apply a patch",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      });
    }
  }
  return out;
}

/** 只做语义别名，不跨档搬移（与 OpenAI/Anthropic 路径保持一致） */
export function responsesEffort(reasoning) {
  if (!reasoning || typeof reasoning !== "object") return undefined;
  const e = reasoning.effort;
  if (typeof e !== "string" || !e) return undefined;
  const k = e.toLowerCase();
  const MAP = { none: "off", minimal: "low", ultra: "max" };
  return MAP[k] ?? k;
}

// ── 响应构造 ──────────────────────────────────────────────
export function createSeq() {
  let n = 0;
  return () => n++;
}

export function newResponseId() {
  return "resp_" + Math.random().toString(36).slice(2).padEnd(20, "0").slice(0, 20);
}

export function newItemId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2).padEnd(18, "0").slice(0, 18);
}

export function toResponsesUsage(u) {
  const w = wireToOpenAIUsage(u) || {};
  return {
    input_tokens: w.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: w.prompt_cache_hit_tokens ?? 0 },
    output_tokens: w.completion_tokens ?? 0,
    // A8: 之前写死 0，导致 Responses 路径的推理 token 统计永远是 0
    output_tokens_details: {
      reasoning_tokens: w.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: w.total_tokens ?? 0,
  };
}

/** wire content[] → Responses output items，按出现顺序 */
export function wireToOutputItems(content) {
  const items = [];
  for (const c of content || []) {
    if (c.type === "thinking") {
      items.push({
        id: newItemId("rs"),
        type: "reasoning",
        summary: [],
        content: [{ type: "reasoning_text", text: c.thinking }],
      });
    } else if (c.type === "text") {
      items.push({
        id: newItemId("msg"),
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: c.text, annotations: [] }],
      });
    } else if (c.type === "tool_use") {
      items.push({
        id: newItemId("fc"),
        type: "function_call",
        call_id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.input ?? {}),
        status: "completed",
      });
    }
  }
  return items;
}

export function makeResponseObject({ id, model, status, output, usage, error, incomplete }) {
  return {
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
}
