// 复刻官方 DeepSeek API 的关键行为，逐项对比本地反代
import http from "node:http";

const PORT = Number(process.argv[2] || 8787);
const MODEL = "deepseek/deepseek-v4-flash";

function post(payload, timeout = 120000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer proxy-managed",
                   "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = ""; res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => { let p = null; try { p = JSON.parse(d); } catch { }
          resolve({ status: res.statusCode, data: d, parsed: p }); });
      }
    );
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: -1, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: -1, error: e.message }));
    req.write(body); req.end();
  });
}

async function postR(payload, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await post(payload);
    if (r.status !== 502 && r.status !== -1) return r;
    await new Promise((s) => setTimeout(s, 1200));
  }
  return post(payload);
}

let diffs = 0;
const show = (label, cond, detail, official) => {
  if (!cond) diffs++;
  console.log(`  ${cond ? "OK  " : "DIFF"}  ${label}`);
  if (detail) console.log(`        实测: ${detail}`);
  if (official) console.log(`        官方: ${official}`);
};

// ── 1. 官方模型名 deepseek-flash ─────────────────────────────
console.log("=== 1. 官方模型名（文档：deepseek-flash / deepseek-v4-pro）===");
for (const m of ["deepseek-flash", "deepseek-v4-pro", "deepseek/deepseek-v4-flash"]) {
  const r = await postR({ model: m, messages: [{ role: "user", content: "hi" }], max_tokens: 20 });
  show(`模型名 ${m}`, r.status === 200, `HTTP ${r.status}`,
    r.status !== 200 ? "官方接受 deepseek-flash" : undefined);
}

// ── 2. reasoning_effort 三档（官方 low/high/max）────────────
console.log("\n=== 2. reasoning_effort 档位（官方支持 low/high/max，none 关闭）===");
for (const e of ["none", "low", "high", "max"]) {
  const r = await postR({ model: MODEL, messages: [{ role: "user", content: "2+2?" }], max_tokens: 200, reasoning_effort: e });
  const rt = r.parsed?.usage?.completion_tokens_details?.reasoning_tokens;
  show(`reasoning_effort=${e}`, r.status === 200, `HTTP ${r.status}, reasoning_tokens=${rt}`,
    e === "none" ? "官方 none = 关闭思考" : `官方 ${e} 为合法档位`);
}

// ── 3. /v1/models 元数据（官方有 context_window 等）──────────
console.log("\n=== 3. /v1/models 元数据（官方含 context_window/max_output_tokens/effort）===");
{
  const r = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: PORT, path: "/v1/models" }, (res) => {
      let d = ""; res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => { let p = null; try { p = JSON.parse(d); } catch { } resolve({ status: res.statusCode, parsed: p }); });
    }).on("error", () => resolve({ status: -1, parsed: null }));
  });
  const ids = (r.parsed?.data || []).map((m) => m.id);
  const others = ids.filter((i) => !/^deepseek\//.test(i));
  const m = (r.parsed?.data || []).find((x) => x.id === MODEL);
  show("只返回 DeepSeek 模型", others.length === 0,
    `deepseek ${ids.length - others.length} 个 / 其它 ${others.length} 个`,
    "官方只返回自家 2 个模型");
  show("含 context_window", m?.context_window !== undefined, String(m?.context_window), "1048576");
  show("含 max_output_tokens", m?.max_output_tokens !== undefined, String(m?.max_output_tokens), "393216");
  show("含 effort.supported_levels", !!m?.effort?.supported_levels, JSON.stringify(m?.effort), `["low","high","max"]`);
  show("含 name 展示名", !!m?.name, String(m?.name), "DeepSeek-V4.1-Flash");
  show("含 input_modalities", !!m?.input_modalities, JSON.stringify(m?.input_modalities), `["text","image"]`);
}

// ── 4. usage 缓存字段 ───────────────────────────────────────
console.log("\n=== 4. usage 缓存字段（官方有 prompt_cache_hit_tokens/miss）===");
{
  const big = "请详细解释这段代码的作用：" + "function a(){return 1}".repeat(200);
  const r = await postR({ model: MODEL, messages: [{ role: "user", content: big }], max_tokens: 30 });
  const u = r.parsed?.usage || {};
  show("prompt_cache_hit_tokens", u.prompt_cache_hit_tokens !== undefined, String(u.prompt_cache_hit_tokens),
    "官方返回此字段");
  show("prompt_cache_miss_tokens", u.prompt_cache_miss_tokens !== undefined, String(u.prompt_cache_miss_tokens),
    "官方返回此字段");
  show("prompt_tokens_details.cached_tokens", u.prompt_tokens_details?.cached_tokens !== undefined,
    String(u.prompt_tokens_details?.cached_tokens), "OpenAI 风格替代");
}

// ── 5. n>1 与 logprobs ─────────────────────────────────────
console.log("\n=== 5. n>1 / logprobs（官方不支持，反代也不该假装支持）===");
{
  const rn = await postR({ model: MODEL, messages: [{ role: "user", content: "say one word" }], max_tokens: 30, n: 2 });
  show("n=2 返回条数", rn.parsed?.choices?.length === 1,
    `choices.length=${rn.parsed?.choices?.length}`, "官方 DeepSeek 不支持 n>1，静默忽略");
  const rl = await postR({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 20, logprobs: true });
  show("logprobs 返回 null/缺失", !rl.parsed?.choices?.[0]?.logprobs,
    String(!!rl.parsed?.choices?.[0]?.logprobs), "官方不支持 logprobs");
}

// ── 6. 错误格式对齐官方 ─────────────────────────────────────
console.log("\n=== 6. 错误体格式（官方：{error:{message,type,param,code}}）===");
{
  const r = await postR({ model: "no-such-model", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });
  const e = r.parsed?.error;
  show("是 4xx", r.status >= 400 && r.status < 500, `HTTP ${r.status}`, "官方 400/401/402/422/429");
  show("error.message 存在", !!e?.message);
  show("error.type 存在", !!e?.type, String(e?.type), "如 invalid_request_error");
  show("error.code 存在", e?.code !== undefined, String(e?.code), "如 model_not_found");
  if (e) console.log("        完整错误体:", JSON.stringify(e).slice(0, 260));
}

// ── 7. 流式细节 ────────────────────────────────────────────
console.log("\n=== 7. 流式（官方：data: {...}\\n\\n，末尾 data: [DONE]）===");
{
  const r = await postR({ model: MODEL, messages: [{ role: "user", content: "count 1 to 5" }], max_tokens: 60, stream: true, stream_options: { include_usage: true } });
  const lines = r.data.split("\n");
  const dataLines = lines.filter((l) => l.trim().startsWith("data:"));
  const chunks = [];
  for (const l of dataLines) { const p = l.trim().slice(5).trim(); if (p === "[DONE]") continue; try { chunks.push(JSON.parse(p)); } catch { } }
  const last = chunks[chunks.length - 1];
  show("首 chunk 有 role", !!chunks[0]?.choices?.[0]?.delta?.role, String(chunks[0]?.choices?.[0]?.delta?.role), "assistant");
  show("含 finish_reason", chunks.some((c) => c.choices?.[0]?.finish_reason), "有一个 chunk 带 finish_reason");
  show("include_usage 生效", !!last?.usage, JSON.stringify(last?.usage)?.slice(0, 80));
  show("usage chunk choices 为空", Array.isArray(last?.choices) && last.choices.length === 0);
  show("以 [DONE] 结束", r.data.trimEnd().endsWith("[DONE]"));
  show("SSE 双换行分隔", r.data.includes("\n\n"));
}

// ── 8. 思考模式默认行为 ─────────────────────────────────────
console.log("\n=== 8. 默认是否思考（官方 Flash 默认开思考）===");
{
  // 用需要推理的问题：对 "1+1" 这类简单题，模型往往直接作答、不产生思考，
  // 那属于模型行为而非协议差异。这里换成会触发推理的提问，才能真正验证
  // 「默认开启思考」这条契约。
  const r = await postR({
    model: MODEL,
    messages: [{ role: "user", content: "计算 17*23，并解释每一步推理过程。" }],
    max_tokens: 1500,
  });
  const rt = r.parsed?.usage?.completion_tokens_details?.reasoning_tokens;
  const hasRC = !!r.parsed?.choices?.[0]?.message?.reasoning_content;
  show("默认产生 reasoning", (rt ?? 0) > 0, `reasoning_tokens=${rt}`, "官方默认开启思考模式");
  show("返回 reasoning_content", hasRC, hasRC ? "(有)" : "(无)");
}

console.log(`\n──────── 共 ${diffs} 处差异 ────────`);
process.exit(diffs > 0 ? 1 : 0);
