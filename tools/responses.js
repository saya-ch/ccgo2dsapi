// responses.js —— 把 OpenAI Responses API 请求翻译成上游成格式
//
// 基准：https://api-docs.deepseek.com/zh-cn/guides/responses_api
//
// 关键差异（与 Chat Completions 相比）：
//   · 输入是 `input` item 列表，不是 messages
//   · 事件序列是 response.created → *.delta → response.completed，没有 [DONE]
//   · 输出是 `output` item 列表（reasoning / message / function_call）
//   · max_tokens 改名为 max_output_tokens
//   · reasoning.effort 控制思考档位，text.format 控制结构化输出

// ── 请求：Responses input → CC messages ─────────────────────
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && (p.type === "input_text" || p.type === "output_text" || p.type === "text"))
    .map((p) => p.text ?? "")
    .join("");
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  // 8787 只认 OpenAI 形状 {type:"image_url", image_url:{url}}；
  // 若输出 {type:"image"} 会被上游静默降级成空文本，图片内容直接丢失。
  return content
    .filter((p) => p && p.type === "input_image")
    .map((p) => {
      const url = p.image_url ?? p.file_id ?? "";
      return { type: "image_url", image_url: { url } };
    })
    .filter((p) => p.image_url?.url);
}

export function toCCMessagesFromInput(input, instructions) {
  const systemParts = [];
  const ccMessages = [];
  const pendingToolNames = new Map();

  if (typeof instructions === "string" && instructions.length > 0) {
    systemParts.push(instructions);
  }

  // input 可以是纯字符串
  if (typeof input === "string") {
    return { ccMessages: [{ role: "user", content: input }], systemPrompt: systemParts.join("\n\n") || undefined };
  }

  const items = Array.isArray(input) ? input : [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const t = item.type;

    // 纯消息（无 type 字段时也当 message）
    if (!t || t === "message") {
      const role = item.role ?? "user";
      const text = textFromContent(item.content);
      const imgs = imageParts(item.content);

      if (role === "system" || role === "developer") {
        if (text) systemParts.push(text);
        continue;
      }
      if (role === "assistant") {
        if (text) ccMessages.push({ role: "assistant", content: text });
        continue;
      }
      // user
      if (imgs.length > 0) {
        const parts = [];
        if (text) parts.push({ type: "text", text });
        parts.push(...imgs);
        ccMessages.push({ role: "user", content: parts });
      } else {
        ccMessages.push({ role: "user", content: text });
      }
      continue;
    }

    // 上一轮的工具调用
    if (t === "function_call" || t === "custom_tool_call") {
      const id = item.call_id ?? item.id ?? "";
      const name = item.name ?? "";
      let args = item.arguments ?? item.input ?? "{}";
      if (typeof args !== "string") args = JSON.stringify(args);
      pendingToolNames.set(id, name);
      let parsed;
      try { parsed = JSON.parse(args); } catch { parsed = args; }
      ccMessages.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: name, input: parsed }],
      });
      continue;
    }

    // 工具结果
    if (t === "function_call_output" || t === "custom_tool_call_output") {
      const id = item.call_id ?? "";
      let out = item.output;
      if (Array.isArray(out)) out = textFromContent(out);
      if (typeof out !== "string") out = JSON.stringify(out ?? "");
      ccMessages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: id,
          toolName: pendingToolNames.get(id) ?? "",
          output: { type: "text", value: out },
        }],
      });
      continue;
    }

    // reasoning / web_search_call 等：按官方语义忽略或归并，这里直接跳过
  }

  return {
    ccMessages,
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

// ── 请求：Responses tools → CC tools ────────────────────────
export function toCCToolsFromResponses(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t) continue;
    // 官方只支持 function 与 custom(apply_patch)，其余忽略
    if (t.type === "function") {
      out.push({
        name: t.name,
        description: t.description,
        input_schema: t.parameters ?? { type: "object", properties: {} },
      });
    } else if (t.type === "custom" && t.name === "apply_patch") {
      out.push({
        name: "apply_patch",
        description: t.description ?? "Apply a patch to the repository",
        input_schema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      });
    }
    // web_search / file_search / code_interpreter / mcp 等忽略
  }
  return out.length > 0 ? out : undefined;
}

// ── 请求：tool_choice ──────────────────────────────────────
export function resolveToolChoice(tc) {
  if (!tc) return undefined;
  if (tc === "auto") return undefined;
  if (tc === "required") return { type: "any" };
  if (tc === "none") return undefined;
  if (typeof tc === "object") {
    if (tc.type === "function" && tc.name) return { type: "tool", name: tc.name };
    if (tc.type === "custom" && tc.name) return { type: "tool", name: tc.name };
  }
  return undefined;
}

// ── 请求：reasoning.effort ────────────────────────────────
export function resolveEffort(reasoning) {
  if (!reasoning || typeof reasoning !== "object") return undefined;
  const e = reasoning.effort;
  if (typeof e !== "string" || e.length === 0) return undefined;
  const k = e.toLowerCase();
  // 只做「官方档位 → 上游档位」的语义别名归一，不跨档位搬移。
  // medium/xhigh 必须原样透传：上游 resolveEffortForModel 会按 DeepSeek
  // 支持集 {low,high,max} 统一裁剪；若在这里预先映射，同一输入在
  // Responses 与 Chat/Anthropic 两条路径上会得到不同推理强度。
  const MAP = {
    none: "off",
    minimal: "low",
    ultra: "max",
  };
  return MAP[k] ?? k;
}

// ── 响应构造 ──────────────────────────────────────────────
// sequence_number 必须是请求局部的：模块级计数器在两个并发流之间
// 会互相 reset，导致序号回退，严格校验的客户端会报错。
export function createSeq() {
  let n = 0;
  return () => n++;
}

export function newResponseId() {
  const rnd = Math.random().toString(36).slice(2).padEnd(20, "0");
  return "resp_" + rnd.slice(0, 20);
}

export function newItemId(prefix) {
  const rnd = Math.random().toString(36).slice(2).padEnd(18, "0");
  return prefix + "_" + rnd.slice(0, 18);
}

// 把 CC 的 usage 换成 Responses 的 usage 形状
export function toResponsesUsage(u) {
  if (!u) {
    return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
  }
  const input = u.promptTokens ?? 0;
  const output = u.completionTokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.promptTokensDetails?.cachedTokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u.completionTokensDetails?.reasoningTokens ?? 0 },
    total_tokens: u.totalTokens ?? input + output,
  };
}
