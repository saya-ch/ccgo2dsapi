// verify-anthropic.mjs —— 对照 DeepSeek 官方 Anthropic 协议，验证本地反代
//
// 基准：https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/
// 覆盖官方兼容性表里的关键项：认证头、忽略字段、thinking 开关、
// output_config.effort 档位、claude-* 模型映射、tool_use 往返、流式事件。
//
// 用法：
//   node tools/verify-anthropic.mjs [port]
//   npm run verify:anthropic
//
// 注意：会消耗少量套餐额度（每次请求按 token 计费）。
import http from "node:http";

const PORT = Number(process.argv[2] || 8787);
const MODEL = "deepseek/deepseek-v4-flash";

function post(body, headers = {}, timeout = 120000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path: "/v1/messages", method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "anthropic-version": "2023-06-01",
          "x-api-key": "proxy-managed",
          ...headers,
        },
      },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let j = null;
          try { j = JSON.parse(d); } catch { }
          resolve({ status: res.statusCode, raw: d, json: j });
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
let quotaHit = false;

function check(label, ok, detail, official) {
  if (!ok) diffs++;
  console.log(`  ${ok ? "OK  " : "DIFF"}  ${label}`);
  if (detail) console.log(`        实测: ${detail}`);
  if (official) console.log(`        官方: ${official}`);
}

function isQuota(r) {
  if (r.status === 429) { quotaHit = true; return true; }
  return false;
}

const BASE = { max_tokens: 400, messages: [{ role: "user", content: "hi" }] };

// ── 1. 基础调用与响应结构 ───────────────────────────────────
console.log("=== 1. 基础 message 调用 ===");
{
  const r = await post({ ...BASE, model: MODEL, messages: [{ role: "user", content: "Reply with exactly: ANTH_OK" }] });
  if (isQuota(r)) {
    console.log("  SKIP  额度已用尽（5 小时窗口），稍后重跑");
  } else if (r.status !== 200) {
    console.log("  FAIL", r.status, r.raw.slice(0, 200));
    diffs++;
  } else {
    check("HTTP 200", true);
    check("type == message", r.json.type === "message", r.json.type, "message");
    check("content 为数组", Array.isArray(r.json.content), `blocks=${r.json.content?.length}`);
    check("stop_reason 存在", !!r.json.stop_reason, r.json.stop_reason);
    check("usage.input_tokens", r.json.usage?.input_tokens != null, String(r.json.usage?.input_tokens));
    check("usage.output_tokens", r.json.usage?.output_tokens != null, String(r.json.usage?.output_tokens));
  }
}

// ── 2. 认证与版本头 ────────────────────────────────────────
console.log("\n=== 2. 版本头（官方：anthropic-version 被忽略）===");
{
  const r = await post(
    { ...BASE, model: MODEL },
    { "anthropic-version": "1999-01-01" }
  );
  if (!isQuota(r)) {
    check("任意 anthropic-version 都被接受", r.status === 200, `HTTP ${r.status}`, "忽略该头");
  } else {
    console.log("  SKIP  额度已用尽");
  }
}

// ── 3. thinking 开关 ───────────────────────────────────────
console.log("\n=== 3. thinking 开关（官方：budget_tokens 被忽略）===");
{
  const en = await post({
    ...BASE, model: MODEL, max_tokens: 900,
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [{ role: "user", content: "What is 17*23? Think it through." }],
  });
  if (!isQuota(en)) {
    check("budget_tokens >= max_tokens 不被拒绝", en.status === 200, `HTTP ${en.status}`, "官方忽略 budget_tokens，应返回 200");
    const blocks = (en.json?.content ?? []).map((b) => b.type);
    check("enabled 时返回 thinking 块", blocks.includes("thinking"), blocks.join(", ") || `HTTP ${en.status}`, "thinking");
  } else {
    console.log("  SKIP  额度已用尽");
  }

  const dis = await post({
    ...BASE, model: MODEL,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: "What is 17*23?" }],
  });
  if (!isQuota(dis)) {
    const blocks = (dis.json?.content ?? []).map((b) => b.type);
    check("disabled 时不返回 thinking 块", dis.status === 200 && !blocks.includes("thinking"), `${blocks.join(", ") || "空"} (HTTP ${dis.status})`, "200 且无 thinking");
  } else {
    console.log("  SKIP  额度已用尽");
  }
}

// ── 4. output_config.effort ────────────────────────────────
console.log("\n=== 4. output_config.effort（官方：none=关闭，low/high/max 为档位）===");
for (const eff of ["none", "high"]) {
  const r = await post({
    ...BASE, model: MODEL, max_tokens: 600,
    output_config: { effort: eff },
    messages: [{ role: "user", content: "2+2?" }],
  });
  if (isQuota(r)) { console.log(`  SKIP  effort=${eff}（额度用尽）`); continue; }
  const hasThink = (r.json?.content ?? []).some((b) => b.type === "thinking");
  check(`effort=${eff} 被接受`, r.status === 200, `HTTP ${r.status}, thinking=${hasThink}`,
    eff === "none" ? "关闭思考" : "开启思考");
}

// ── 5. 官方忽略字段不应报错 ────────────────────────────────
console.log("\n=== 5. 官方标为「忽略」的字段不应导致报错 ===");
{
  const r = await post({
    ...BASE, model: MODEL,
    metadata: { user_id: "u-1", extra: "x" },
    service_tier: "auto",
    top_k: 5,
    container: "c1",
    mcp_servers: [],
  });
  if (!isQuota(r)) {
    check("一并传入不报错", r.status === 200, `HTTP ${r.status}`, "全部忽略但不报错");
  } else {
    console.log("  SKIP  额度已用尽");
  }
}

// ── 6. claude-* 模型映射 ───────────────────────────────────
console.log("\n=== 6. claude-* 模型映射（官方：opus→v4-pro，sonnet/haiku→flash）===");
for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
  const r = await post({ ...BASE, max_tokens: 60, model: m });
  if (isQuota(r)) { console.log(`  SKIP  ${m}（额度用尽）`); continue; }
  check(`${m} 可用`, r.status === 200, `HTTP ${r.status}`, "映射到对应 DeepSeek 模型");
}

// ── 7. tool_use 往返 ───────────────────────────────────────
console.log("\n=== 7. tool_use / tool_result ===");
{
  const tools = [{
    name: "get_weather",
    description: "Get weather for a city",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }];
  const r = await post({
    ...BASE, model: MODEL, max_tokens: 800, tools, tool_choice: { type: "auto" },
    messages: [{ role: "user", content: "What's the weather in Tokyo? Use the tool." }],
  });
  if (isQuota(r)) {
    console.log("  SKIP  额度已用尽");
  } else {
    const uses = (r.json?.content ?? []).filter((b) => b.type === "tool_use");
    check("返回 tool_use 块", uses.length > 0,
      `HTTP ${r.status}, tool_use=${uses.length}` + (uses[0] ? ` name=${uses[0].name}` : ""), "tool_use");
    check("stop_reason == tool_use", r.json?.stop_reason === "tool_use", r.json?.stop_reason, "tool_use");

    if (uses.length > 0) {
      const r2 = await post({
        ...BASE, model: MODEL, max_tokens: 400, tools,
        messages: [
          { role: "user", content: "What's the weather in Tokyo? Use the tool." },
          { role: "assistant", content: [uses[0]] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: uses[0].id, content: "Sunny, 22C" }] },
        ],
      });
      if (!isQuota(r2)) {
        check("tool_result 回传后正常续答", r2.status === 200, `HTTP ${r2.status}`, "200");
      }
    }
  }
}

// ── 8. 流式事件序列 ────────────────────────────────────────
console.log("\n=== 8. 流式事件序列 ===");
{
  const r = await post({
    ...BASE, model: MODEL, max_tokens: 200, stream: true,
    messages: [{ role: "user", content: "count 1 to 5" }],
  });
  if (r.status === 429) {
    console.log("  SKIP  额度已用尽");
  } else {
    const events = [...r.raw.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
    const uniq = [...new Set(events)];
    check("流式返回事件", events.length > 0, `事件数=${events.length}`);
    console.log("        事件类型:", uniq.join(", ") || "(无)");
    check("含 message_start", uniq.includes("message_start"), uniq.includes("message_start") ? "有" : "缺失", "message_start");
    check("含 content_block_delta", uniq.includes("content_block_delta"), uniq.includes("content_block_delta") ? "有" : "缺失", "content_block_delta");
    check("含 message_stop", uniq.includes("message_stop"), uniq.includes("message_stop") ? "有" : "缺失", "message_stop");
  }
}

console.log(`\n──────── 共 ${diffs} 处差异 ────────`);
if (quotaHit) {
  console.log("注意：本次运行遇到 429 额度限制，部分断言被跳过；窗口重置后重跑可得到完整结果。");
}
process.exit(diffs > 0 ? 1 : 0);
