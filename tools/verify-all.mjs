// verify-all.mjs —— 一个命令跑完三套协议的对齐验证
//
//   npm run verify            三套全跑
//   npm run verify:openai     只跑 OpenAI Chat Completions
//   npm run verify:anthropic  只跑 Anthropic Messages
//   npm run verify:responses  只跑 Responses
//
// 需要 8787（主代理）与 8788（Responses 适配层）都在运行。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const suites = [
  { name: "OpenAI Chat Completions", script: "verify-parity.mjs", port: 8787 },
  { name: "Anthropic Messages", script: "verify-anthropic.mjs", port: 8787 },
  { name: "Responses", script: "verify-responses.mjs", port: 8788 },
];

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/health", method: "GET" },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.setTimeout(2500, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function run(script, port) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, script), String(port)], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (c) => {
      out += c;
      process.stdout.write(c);
    });
    p.stderr.on("data", (c) => process.stderr.write(c));
    p.on("close", (code) => resolve({ code, out }));
    p.on("error", () => resolve({ code: -1, out }));
  });
}

const results = [];

for (const s of suites) {
  const alive = await probeHealth(s.port);
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  ${s.name}   (port ${s.port})`);
  console.log("═".repeat(66));

  if (!alive) {
    console.log(`  SKIP  端口 ${s.port} 没有服务在监听`);
    if (s.port === 8788) {
      console.log("         Responses 需要 tools/responses-server.mjs，用 .\\launch.ps1 启动会自动拉起");
    } else {
      console.log("         先启动代理：.\\launch.ps1 或 .\\scripts\\start-proxy.ps1");
    }
    results.push({ ...s, status: "skipped", diffs: null });
    continue;
  }

  const { code, out } = await run(s.script, s.port);
  const m = out.match(/共\s*(\d+)\s*处差异/);
  const diffs = m ? Number(m[1]) : null;
  results.push({ ...s, status: code === 0 ? "pass" : "fail", diffs });
}

// ── 汇总 ──────────────────────────────────────────────────
console.log(`\n${"═".repeat(66)}`);
console.log("  汇总");
console.log("═".repeat(66));
let failed = 0;
for (const r of results) {
  const tag = r.status === "pass" ? "PASS" : r.status === "skipped" ? "SKIP" : "FAIL";
  const d = r.diffs == null ? "" : `  差异 ${r.diffs}`;
  console.log(`  ${tag.padEnd(5)} ${r.name}${d}`);
  if (r.status === "fail") failed++;
}

console.log("");
if (failed === 0) {
  const passed = results.filter((r) => r.status === "pass").length;
  console.log(`  ${passed}/${results.length} 套协议验证通过`);
  process.exit(0);
} else {
  console.log(`  ${failed} 套协议未通过`);
  process.exit(1);
}
