// verify-all.mjs —— 一个命令跑完三套协议的对齐验证
//
//   npm run verify            三套全跑
//   npm run verify:openai     只跑 OpenAI Chat Completions
//   npm run verify:anthropic  只跑 Anthropic Messages
//   npm run verify:responses  只跑 Responses
//
// 需要 8787（三套协议共用同一端口）在运行。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// 自研网关把三套协议放在同一个端口上
const suites = [
  { name: "OpenAI Chat Completions", script: "verify-parity.mjs", port: 8787 },
  { name: "Anthropic Messages", script: "verify-anthropic.mjs", port: 8787 },
  { name: "Responses", script: "verify-responses.mjs", port: 8787 },
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
    console.log("        先启动网关：.\\launch.ps1 或 npm start");
    results.push({ ...s, status: "skipped", diffs: null });
    continue;
  }

  const { code, out } = await run(s.script, s.port);
  const m = out.match(/共\s*(\d+)\s*处差异/);
  const diffs = m ? Number(m[1]) : null;
  // 子脚本因额度耗尽跳过部分断言时会返回 2，并在汇总行标注「N 组因额度跳过」。
  // 这种结果既不是 pass 也不是 fail——它是「没验完」，必须单独记为 skipped，
  // 否则额度耗尽时整张面板会显示假绿。
  const skipM = out.match(/（(\d+) 组因额度跳过）/);
  const skippedGroups = skipM ? Number(skipM[1]) : 0;
  const incomplete = code === 2 || skippedGroups > 0;
  // 双重判定：退出码为 0 且解析出的差异数为 0、且没有跳过，才算通过。
  // 只看退出码会漏掉那些打印了差异却不设置退出码的脚本。
  const passed = code === 0 && diffs === 0 && !incomplete;
  const status = incomplete ? "skipped" : passed ? "pass" : "fail";
  results.push({ ...s, status, diffs, skippedGroups });
}

// ── 汇总 ──────────────────────────────────────────────────
console.log(`\n${"═".repeat(66)}`);
console.log("  汇总");
console.log("═".repeat(66));
let failed = 0;
for (const r of results) {
  const tag = r.status === "pass" ? "PASS" : r.status === "skipped" ? "SKIP" : "FAIL";
  const d = r.diffs == null ? "" : `  差异 ${r.diffs}`;
  const sk = r.skippedGroups ? `  （${r.skippedGroups} 组因额度跳过，未验完）` : "";
  console.log(`  ${tag.padEnd(5)} ${r.name}${d}${sk}`);
  if (r.status === "fail") failed++;
}

const passed = results.filter((r) => r.status === "pass").length;
const skipped = results.filter((r) => r.status === "skipped").length;

console.log("");
if (skipped > 0) {
  // SKIP 不等于通过：服务没起来时一个断言都没跑，说「通过」是假绿。
  console.log(`  ${passed}/${results.length} 套通过，${skipped} 套被跳过（服务未启动或额度不足），结果不完整`);
  console.log("  未验证不等于通过，退出码 1");
  process.exit(1);
}
if (failed === 0) {
  console.log(`  ${passed}/${results.length} 套协议验证通过`);
  process.exit(0);
}
console.log(`  ${failed} 套协议未通过`);
process.exit(1);
