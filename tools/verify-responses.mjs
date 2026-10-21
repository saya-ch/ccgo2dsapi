// verify-responses.mjs —— 对照 DeepSeek 官方 Responses API 规范验证
//
// 基准：https://api-docs.deepseek.com/zh-cn/guides/responses_api
// 注意：Responses 由 tools/responses-server.mjs 提供，默认端口 8788。
//
// 用法：
//   node tools/verify-responses.mjs [port]
//   npm run verify:responses
import http from "node:http";

const PORT = Number(process.argv[2] || 8788);
const MODEL = "deepseek/deepseek-v4-flash";

function post(body, timeout = 120000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/v1/responses", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (r) => {
        let d = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          let j = null; try { j = JSON.parse(d); } catch { }
          resolve({ status: r.statusCode, raw: d, json: j });
        });
      }
    );
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: -1, raw: "timeout", json: null }); });
    req.on("error", (e) => resolve({ status: -1, raw: e.message, json: null }));
    req.write(payload);
    req.end();
  });
}

let diffs = 0;
let skipped = 0;
const check = (label, ok, detail, official) => {
  if (!ok) diffs++;
  console.log(`  ${ok ? "OK  " : "DIFF"}  ${label}`);
  if (detail) console.log(`        实测: ${detail}`);
  if (official) console.log(`        官方: ${official}`);
};

// ── 1. 非流式基础结构 ──────────────────────────────────────
console.log("=== 1. 非流式：响应对象结构 ===");
{
  const r = await post({ model: MODEL, input: "Reply with exactly: RESP_OK", instructions: "You are helpful." });
  if (r.status === 429) {
    console.log("  SKIP  额度已用尽");
    skipped++;
  } else if (r.status !== 200) {
    console.log("  FAIL", r.status, r.raw.slice(0, 200));
    diffs++;
  } else {
    check("HTTP 200", true);
    check("object == response", r.json.object === "response", r.json.object, "response");
    check("id 前缀 resp_", String(r.json.id).startsWith("resp_"), r.json.id, "resp_*");
    check("status == completed", r.json.status === "completed", r.json.status, "completed");
    check("output 是数组", Array.isArray(r.json.output), `items=${r.json.output?.length}`);
    const msg = (r.json.output ?? []).find((i) => i.type === "message");
    check("含 message item", !!msg, (r.json.output ?? []).map((i) => i.type).join(", "), "message");
    check("content[0].type == output_text", msg?.content?.[0]?.type === "output_text", msg?.content?.[0]?.type, "output_text");
    check("usage.input_tokens", r.json.usage?.input_tokens != null, String(r.json.usage?.input_tokens));
    check("usage.output_tokens", r.json.usage?.output_tokens != null, String(r.json.usage?.output_tokens));
    check("usage.input_tokens_details", r.json.usage?.input_tokens_details != null, JSON.stringify(r.json.usage?.input_tokens_details), "含 cached_tokens");
    check("store == false", r.json.store === false, String(r.json.store), "恒为 false");
  }
}

// ── 2. input item 列表 + reasoning ────────────────────────
console.log("\n=== 2. input item 列表 + reasoning.effort ===");
{
  const r = await post({
    model: MODEL,
    input: [{ role: "user", content: [{ type: "input_text", text: "What is 17*23? Think it through." }] }],
    reasoning: { effort: "high" },
    max_output_tokens: 2000,
  });
  if (r.status === 429) { console.log("  SKIP  额度已用尽"); skipped++; }
  else if (r.status !== 200) { console.log("  FAIL", r.status, r.raw.slice(0, 150)); diffs++; }
  else {
    const types = (r.json.output ?? []).map((i) => i.type);
    check("input 为 item 列表时可用", true, "HTTP 200");
    check("含 reasoning item", types.includes("reasoning"), types.join(", "), "reasoning");
    const rs = (r.json.output ?? []).find((i) => i.type === "reasoning");
    if (rs) check("content[0].type == reasoning_text", rs.content?.[0]?.type === "reasoning_text", rs.content?.[0]?.type, "reasoning_text");
  }
}

// ── 3. 截断 → incomplete ──────────────────────────────────
console.log("\n=== 3. 截断：status/incomplete_details ===");
{
  const r = await post({ model: MODEL, input: "写一段 500 字以上文章，主题不限。", max_output_tokens: 30 });
  if (r.status === 429) { console.log("  SKIP  额度已用尽"); skipped++; }
  else if (r.status !== 200) { console.log("  FAIL", r.status); diffs++; }
  else {
    check("status 为 completed 或 incomplete", ["completed", "incomplete"].includes(r.json.status), r.json.status, "达到上限时 incomplete");
    if (r.json.status === "incomplete") {
      check("incomplete_details.reason", r.json.incomplete_details?.reason === "max_output_tokens",
        String(r.json.incomplete_details?.reason), "max_output_tokens");
    }
  }
}

// ── 4. function 工具 ──────────────────────────────────────
console.log("\n=== 4. function 工具调用 ===");
{
  const r = await post({
    model: MODEL,
    input: "What's the weather in Tokyo? Use the tool.",
    tools: [{
      type: "function", name: "get_weather", description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }],
    max_output_tokens: 800,
  });
  if (r.status === 429) { console.log("  SKIP  额度已用尽"); skipped++; }
  else if (r.status !== 200) { console.log("  FAIL", r.status); diffs++; }
  else {
    const fcs = (r.json.output ?? []).filter((i) => i.type === "function_call");
    check("返回 function_call item", fcs.length > 0, `count=${fcs.length}`, "function_call");
    if (fcs[0]) {
      check("含 call_id", !!fcs[0].call_id, fcs[0].call_id, "call_*");
      check("含 arguments", typeof fcs[0].arguments === "string", (fcs[0].arguments ?? "").slice(0, 50));
    }
  }
}

// ── 5. 流式事件序列 ───────────────────────────────────────
console.log("\n=== 5. 流式事件序列 ===");
{
  const r = await post({ model: MODEL, input: "count 1 to 5", stream: true, max_output_tokens: 300 });
  if (r.status === 429) { console.log("  SKIP  额度已用尽"); skipped++; }
  else if (r.status !== 200) { console.log("  FAIL", r.status); diffs++; }
  else {
    const evs = [...r.raw.matchAll(/^event: ([^\n]+)/gm)].map((m) => m[1]);
    const uniq = [...new Set(evs)];
    check("有事件流", evs.length > 0, `共 ${evs.length} 个`);
    console.log("        事件类型:", uniq.join(", "));
    check("首事件 response.created", evs[0] === "response.created", evs[0], "response.created");
    check("含 response.output_item.added", uniq.includes("response.output_item.added"), uniq.includes("response.output_item.added") ? "有" : "缺");
    check("含 response.output_text.delta", uniq.includes("response.output_text.delta"), uniq.includes("response.output_text.delta") ? "有" : "缺", "response.output_text.delta");
    check("末事件 response.completed", evs[evs.length - 1] === "response.completed", evs[evs.length - 1], "response.completed");
    check("无 data: [DONE]", !r.raw.includes("data: [DONE]"), r.raw.includes("[DONE]") ? "有（官方无）" : "无", "官方无此消息");
    check("事件带 sequence_number", /"sequence_number":0/.test(r.raw), "有", "递增序号");
  }
}

// ── 6. 参数校验 ───────────────────────────────────────────
console.log("\n=== 6. 缺 input 与 instructions 应 400 ===");
{
  const r = await post({ model: MODEL });
  check("返回 400", r.status === 400, `HTTP ${r.status}`, "400");
}

console.log(`\n──────── 共 ${diffs} 处差异${skipped ? `（${skipped} 组因额度跳过）` : ""} ────────`);
process.exit(diffs > 0 ? 1 : 0);
