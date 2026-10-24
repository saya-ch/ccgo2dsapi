// translate.mjs —— 两种协议 ↔ wire 格式的翻译
//
// 输入侧：OpenAI Chat Completions / Anthropic Messages 的请求
// 输出侧：wire.mjs 的 messages/tools/system
// 返回侧：wire 的 content[] → 各自的响应/事件格式
//
// 所有字段映射依据 DeepSeek 官方文档与本次实测，不照抄第三方实现。

// ══════════════════════════════════════════════════════════
// OpenAI Chat Completions  →  wire
// ══════════════════════════════════════════════════════════

/** 从 data URL 或文件路径推断 MIME；无法判断时返回 undefined 让上游自己决定 */
function inferImageMime(url) {
  if (typeof url !== "string" || !url) return undefined;
  const dataM = /^data:([^;]+);/.exec(url);
  if (dataM) return dataM[1];
  const ext = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(url)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  const map = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  };
  return map[ext];
}

/** OpenAI 的 image_url（字符串或对象）→ data URL 或 http URL */
function openAIImageUrl(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  if (typeof input === "object" && typeof input.url === "string") return input.url;
  return null;
}

export function openAIToWire(req) {
  const systemParts = [];
  const messages = [];
  const toolNames = new Map();

  for (const m of req.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      systemParts.push(typeof m.content === "string" ? m.content : extractText(m.content));
      continue;
    }

    if (m.role === "assistant") {
      const content = [];
      // 历史思考必须回传。官方文档写得很明确：
      //   「携带了 tools 参数的请求，在后续所有请求中，必须完整回传 reasoning_content
      //     给 API —— 即使该轮模型未实际进行工具调用。若未正确回传，API 会返回 400。」
      // 之前这里完全忽略 reasoning_content，模型看不到自己上一轮怎么想的，
      // 于是每轮重新推理一遍，表现为反复「我已经查清了……」然后原地打转。
      const reasoning = m.reasoning_content ?? m.reasoning ?? "";
      if (typeof reasoning === "string" && reasoning.trim()) {
        content.push({ type: "reasoning", text: reasoning });
      }
      const text = typeof m.content === "string" ? m.content : extractText(m.content);
      if (text) content.push({ type: "text", text });
      for (const tc of m.tool_calls || []) {
        const name = tc.function?.name ?? "";
        toolNames.set(tc.id, name);
        content.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: name,
          input: safeParse(tc.function?.arguments),
        });
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }

    if (m.role === "tool") {
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id,
          toolName: toolNames.get(m.tool_call_id) ?? "unknown",
          output: { type: "text", value: typeof m.content === "string" ? m.content : extractText(m.content) },
        }],
      });
      continue;
    }

    // user
    const parts = [];
    if (typeof m.content === "string") {
      parts.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text") parts.push({ type: "text", text: p.text ?? "" });
        else if (p.type === "image_url") {
          const url = openAIImageUrl(p.image_url);
          if (url) {
            const mime = inferImageMime(url);
            parts.push({ type: "image", image: url, ...(mime ? { mimeType: mime } : {}) });
          }
        }
      }
    }
    if (parts.length > 0) messages.push({ role: "user", content: parts });
  }

  return {
    messages,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    tools: (req.tools || []).map((t) => ({
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      input_schema: t.function?.parameters ?? t.parameters ?? { type: "object", properties: {} },
    })),
    maxTokens: clamp(req.max_tokens ?? req.max_completion_tokens),
    temperature: req.temperature,
    effort: normalizeEffort(req.reasoning_effort),
  };
}

/** wire content[] → OpenAI 非流式 message */
export function wireToOpenAIMessage(content) {
  let text = "";
  let reasoning = "";
  const toolCalls = [];

  for (const c of content || []) {
    if (c.type === "text") text += c.text ?? "";
    else if (c.type === "thinking") reasoning += c.thinking;
    else if (c.type === "tool_use") {
      toolCalls.push({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      });
    }
  }

  const msg = { role: "assistant", content: text || null };
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
}

export function wireToOpenAIFinish(stopReason, content) {
  if ((content || []).some((c) => c.type === "tool_use")) return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

/** wire usage → OpenAI usage（含 DeepSeek 的缓存命中字段） */
export function wireToOpenAIUsage(u) {
  if (!u) return undefined;
  const prompt = u.inputTokens ?? 0;
  const completion = u.outputTokens ?? 0;
  // 上游偶尔会报 cacheReadTokens > inputTokens。两边必须用同一个口径，
  // 否则会产出 hit + miss > prompt_tokens 的自相矛盾数字。
  const cached = Math.min(u.cacheReadTokens ?? 0, prompt);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    prompt_cache_hit_tokens: cached,
    prompt_cache_miss_tokens: Math.max(0, prompt - cached),
    completion_tokens_details: { reasoning_tokens: u.reasoningTokens ?? 0 },
  };
}

// ══════════════════════════════════════════════════════════
// Anthropic Messages  →  wire
// ══════════════════════════════════════════════════════════

export function anthropicToWire(req) {
  const systemParts = [];
  if (typeof req.system === "string") systemParts.push(req.system);
  else if (Array.isArray(req.system)) {
    for (const s of req.system) if (s?.type === "text") systemParts.push(s.text);
  }

  const messages = [];
  const toolNames = new Map();

  for (const m of req.messages || []) {
    if (m.role === "assistant") {
      const content = [];
      for (const p of toArray(m.content)) {
        if (p.type === "text") content.push({ type: "text", text: p.text });
        // 上游 wire 的 reasoning 块是 { type: "reasoning", text }，
        // 不是内部块形状 { type: "thinking", thinking }。
        // 写错会被上游当未知类型忽略（历史思考丢失）或 400 拒整条请求。
        else if (p.type === "thinking") content.push({ type: "reasoning", text: p.thinking ?? "" });
        else if (p.type === "tool_use") {
          toolNames.set(p.id, p.name);
          content.push({ type: "tool-call", toolCallId: p.id, toolName: p.name, input: p.input });
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }

    // user：可能同时含图片与 tool_result，wire 要求拆成两条消息
    const toolParts = [];
    const userParts = [];
    for (const p of toArray(m.content)) {
      if (p.type === "text") userParts.push({ type: "text", text: p.text });
      else if (p.type === "image") {
        // 优先用客户端声明的 media_type；URL 图片从扩展名推断；
        // 都拿不到就省略 mimeType，让上游自己判断 —— 不要假设 png。
        const declared = p.source?.media_type;
        const url = p.source?.data
          ? `data:${declared || "image/png"};base64,${p.source.data}`
          : (p.source?.url ?? "");
        const mime = declared || inferImageMime(url);
        userParts.push({ type: "image", image: url, ...(mime ? { mimeType: mime } : {}) });
      } else if (p.type === "tool_result") {
        toolParts.push({
          type: "tool-result",
          toolCallId: p.tool_use_id,
          toolName: toolNames.get(p.tool_use_id) ?? "unknown",
          output: { type: "text", value: extractText(p.content) },
        });
      }
    }
    if (toolParts.length > 0) messages.push({ role: "tool", content: toolParts });
    if (userParts.length > 0) messages.push({ role: "user", content: userParts });
  }

  return {
    messages,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    tools: (req.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema ?? { type: "object", properties: {} },
    })),
    maxTokens: clamp(req.max_tokens),
    temperature: req.temperature,
    effort: anthropicEffort(req),
  };
}

/**
 * Anthropic 的思考控制：
 *   thinking.type = enabled|disabled  +  output_config.effort = low|high|max|none
 * 官方忽略 budget_tokens，这里按 effort 折算。
 */
export function anthropicEffort(req) {
  const th = req.thinking;

  // 显式 disabled 优先级最高：客户端明确说"别思考"，不能被
  // output_config.effort 覆盖，否则白烧 reasoning token。
  if (th && th.type === "disabled") return "off";

  const oc = req.output_config?.effort;
  if (typeof oc === "string") {
    const k = oc.toLowerCase();
    if (k === "none") return "off";
    if (k === "low" || k === "high" || k === "max") return k;
  }
  if (th && th.type === "enabled") {
    const budget = th.budget_tokens;
    if (typeof budget !== "number") return undefined;
    if (budget <= 4096) return "low";
    if (budget >= 32768) return "max";
    return "high";
  }
  return undefined;
}

/** wire content[] → Anthropic content blocks */
export function wireToAnthropicBlocks(content) {
  const blocks = [];
  for (const c of content || []) {
    if (c.type === "thinking") blocks.push({ type: "thinking", thinking: c.thinking, signature: c.signature || "" });
    else if (c.type === "text") blocks.push({ type: "text", text: c.text });
    else if (c.type === "tool_use") blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} });
  }
  return blocks;
}

export function wireToAnthropicStop(stopReason, content) {
  if ((content || []).some((c) => c.type === "tool_use")) return "tool_use";
  if (stopReason === "max_tokens") return "max_tokens";
  return "end_turn";
}

export function wireToAnthropicUsage(u) {
  const input = u?.inputTokens ?? 0;
  const cacheRead = u?.cacheReadTokens ?? 0;
  return {
    input_tokens: Math.max(0, input - cacheRead),
    output_tokens: u?.outputTokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: u?.cacheWriteTokens ?? 0,
  };
}

// ══════════════════════════════════════════════════════════
// 共用
// ══════════════════════════════════════════════════════════

/**
 * 上游 max_tokens 硬上限是 200000，超过直接 400。
 * 客户端常配 256000（DSH 默认值），这里先钳住，
 * 免得整条请求被拒还被误报成传输层错误。
 */
const UPSTREAM_MAX_TOKENS_CAP = 200000;
function clamp(v) {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), UPSTREAM_MAX_TOKENS_CAP);
}
// ══════════════════════════════════════════════════════════

function toArray(c) {
  if (Array.isArray(c)) return c;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return [];
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && (p.type === "text" || p.type === "output_text"))
    .map((p) => p.text ?? "")
    .join("\n");
}

function safeParse(s) {
  if (typeof s !== "string") return s && typeof s === "object" ? s : {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** OpenAI reasoning_effort → wire effort，只做语义别名，不跨档搬移 */
function normalizeEffort(e) {
  if (typeof e !== "string" || !e) return undefined;
  const k = e.toLowerCase();
  const MAP = { none: "off", minimal: "low", ultra: "max", disabled: "off", off: "off" };
  return MAP[k] ?? k;
}

export function openAIError(message, type = "invalid_request_error", code = null, param = null) {
  return { error: { message, type, param, code } };
}

export function anthropicError(message, type = "invalid_request_error") {
  return { type: "error", error: { type, message } };
}
