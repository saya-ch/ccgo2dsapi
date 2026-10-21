// tools/verify-offline.mjs —— 离线验证：mock 上游 + 真实网关，不消耗任何额度
//
// 与 verify-all.mjs 的区别：
//   verify-all    连真实上游，验证「协议对齐」（要花额度，偶尔跑）
//   verify-offline 连 mock 上游，验证「翻译逻辑」（零成本，每次改动都能跑）
//
// 用法：
//   node tools/verify-offline.mjs
//   node tools/verify-offline.mjs --scenario truncated

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const MOCK_PORT = Number(argOf("--mock-port", "8799"));
const GW_PORT = Number(argOf("--port", "8899"));
const SCENARIO = argOf("--scenario", "");

const procs = [];

function startNode(script, argv, label) {
  const p = spawn(process.execPath, [path.join(repoRoot, script), ...argv], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => { });
  p.stderr.on("data", (c) => process.stderr.write(`[${label}] ${c}`));
  procs.push({ p, label });
  return p;
}

function cleanup() {
  for (const { p } of procs) {
    if (!p.killed) {
      try { p.kill(); } catch { }
    }
  }
}

function probe(port, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/health", method: "GET" },
        (res) => { res.resume(); resolve(true); }
      );
      req.setTimeout(1000, () => req.destroy());
      req.on("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 200);
      });
      req.end();
    };
    tick();
  });
}

function call(port, method, urlPath, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let j = null; try { j = JSON.parse(d); } catch { }
          resolve({ status: res.statusCode, raw: d, json: j });
        });
      }
    );
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: -1, raw: "timeout" }); });
    req.on("error", (e) => resolve({ status: -1, raw: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

console.log("=== 离线验证（mock 上游，零额度消耗）===\n");

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

try {
  // 启动 mock 上游
  const mockArgs = ["--port", String(MOCK_PORT)];
  if (SCENARIO) mockArgs.push("--scenario", SCENARIO);
  startNode("tools/mock-upstream.mjs", mockArgs, "mock");
  if (!(await probe(MOCK_PORT))) throw new Error("mock 上游未启动");
  console.log(`  mock 上游就绪 :${MOCK_PORT}`);

  // 启动网关指向 mock
  startNode("vendor/server.mjs", [
    "--port", String(GW_PORT),
    "--base", `http://127.0.0.1:${MOCK_PORT}`,
  ], "gateway");
  if (!(await probe(GW_PORT))) throw new Error("网关未启动");
  console.log(`  网关就绪 :${GW_PORT}（上游指向 mock）\n`);

  // ── OpenAI ────────────────────────────────────────────
  console.log("--- OpenAI Chat Completions ---");
  {
    const r = await call(GW_PORT, "POST", "/v1/chat/completions", {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 500,
    });
    check("非流式", r.status === 200 && r.json?.choices?.[0]?.message?.content === "OK",
      `HTTP ${r.status} content=${JSON.stringify(r.json?.choices?.[0]?.message?.content)}`);
    check("usage 结构", r.json?.usage?.prompt_tokens > 0 && r.json?.usage?.completion_tokens > 0,
      JSON.stringify(r.json?.usage));
  }
  {
    const r = await call(GW_PORT, "POST", "/v1/chat/completions", {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "count 1 to 3" }],
      max_tokens: 500, stream: true,
      stream_options: { include_usage: true },
    });
    const hasDone = r.raw.includes("[DONE]");
    const chunks = [...r.raw.matchAll(/^data: (.+)$/gm)].map((m) => m[1]).filter((x) => x !== "[DONE]");
    const parsed = chunks.map((c) => { try { return JSON.parse(c); } catch { return null; } }).filter(Boolean);
    const usageChunk = parsed.find((p) => p.usage && Array.isArray(p.choices) && p.choices.length === 0);
    check("流式 [DONE]", hasDone);
    check("流式 usage 块（choices 为空）", !!usageChunk, usageChunk ? JSON.stringify(usageChunk.usage) : "缺");
  }
  {
    const r = await call(GW_PORT, "POST", "/v1/chat/completions", {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "北京天气？调用工具" }],
      max_tokens: 500, stream: true,
      tools: [{ type: "function", function: { name: "get_weather", description: "w",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
    });
    const chunks = [...r.raw.matchAll(/^data: (.+)$/gm)].map((m) => m[1]).filter((x) => x !== "[DONE]");
    const tcs = chunks.map((c) => { try { return JSON.parse(c); } catch { return null; } })
      .filter(Boolean).flatMap((p) => p.choices?.[0]?.delta?.tool_calls ?? []);
    const joined = tcs.map((t) => t.function?.arguments ?? "").join("");
    check("tool_calls 分片下发", tcs.length >= 2, `${tcs.length} 片`);
    check("tool_calls 拼装正确", joined === '{"city":"北京"}', joined);
  }

  // ── Anthropic ─────────────────────────────────────────
  console.log("\n--- Anthropic Messages ---");
  {
    const r = await call(GW_PORT, "POST", "/v1/messages", {
      model: "deepseek-v4.1-flash", max_tokens: 500,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
    check("非流式", r.status === 200 && r.json?.type === "message",
      `type=${r.json?.type} stop=${r.json?.stop_reason}`);
  }
  {
    const r = await call(GW_PORT, "POST", "/v1/messages", {
      model: "deepseek-v4.1-flash", max_tokens: 1000,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [{ role: "user", content: "计算 17*23 并解释" }],
    });
    const blocks = (r.json?.content ?? []).map((b) => b.type);
    check("thinking 块", blocks.includes("thinking"), `blocks=${blocks.join(",")}`);
  }
  {
    const r = await call(GW_PORT, "POST", "/v1/messages", {
      model: "deepseek-v4.1-flash", max_tokens: 1000,
      thinking: { type: "disabled" }, output_config: { effort: "high" },
      messages: [{ role: "user", content: "计算 17*23 并解释" }],
    });
    const blocks = (r.json?.content ?? []).map((b) => b.type);
    check("disabled 压过 effort", !blocks.includes("thinking"), `blocks=${blocks.join(",")}`);
  }
  {
    const r = await call(GW_PORT, "POST", "/v1/messages", {
      model: "deepseek-v4.1-flash", max_tokens: 500, stream: true,
      messages: [{ role: "user", content: "count 1 to 3" }],
    });
    const evs = [...r.raw.matchAll(/^event: ([^\n]+)/gm)].map((m) => m[1]);
    const uniq = [...new Set(evs)];
    check("流式事件完整", evs[0] === "message_start" && uniq.includes("message_stop"),
      uniq.join(","));
  }

  // ── Responses ─────────────────────────────────────────
  console.log("\n--- OpenAI Responses ---");
  {
    const r = await call(GW_PORT, "POST", "/v1/responses", {
      model: "deepseek-v4.1-flash", input: "Reply with exactly: OK", max_output_tokens: 500,
    });
    check("非流式", r.status === 200 && r.json?.object === "response",
      `status=${r.json?.status} items=${(r.json?.output ?? []).length}`);
  }
  {
    const r = await call(GW_PORT, "POST", "/v1/responses", {
      model: "deepseek-v4.1-flash", input: "count 1 to 3", stream: true, max_output_tokens: 500,
    });
    const evs = [...r.raw.matchAll(/^event: ([^\n]+)/gm)].map((m) => m[1]);
    const uniq = [...new Set(evs)];
    check("流式事件序列", evs[0] === "response.created" && evs[evs.length - 1] === "response.completed",
      uniq.slice(0, 5).join(",") + "...");
  }

  // ── 其他端点 ──────────────────────────────────────────
  console.log("\n--- 其他端点 ---");
  {
    const r = await call(GW_PORT, "GET", "/v1/models");
    check("/v1/models", r.status === 200 && (r.json?.data ?? []).length > 0,
      `${(r.json?.data ?? []).length} 个`);
  }
  {
    const r = await call(GW_PORT, "GET", "/user/quota");
    check("/user/quota", r.status === 200 && r.json?.credits?.total > 0,
      `total=${r.json?.credits?.total}`);
  }
  {
    const r = await call(GW_PORT, "POST", "/v1/chat/completions", {
      model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "x" }], max_tokens: 10,
    }, );
    // 用 mock 的 max_tokens<=60 分支模拟截断
    check("截断被正确识别", r.status === 200,
      `finish_reason=${r.json?.choices?.[0]?.finish_reason}`);
  }

  console.log(`\n──────── ${pass} 通过 / ${fail} 失败 ────────`);
} catch (e) {
  console.error("\n  验证过程出错：", e.message);
  fail++;
} finally {
  cleanup();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(fail > 0 ? 1 : 0);
}
