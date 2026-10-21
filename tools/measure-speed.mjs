// measure-speed.mjs —— 真流式测速
//
// 为什么不用 PowerShell 的 Invoke-WebRequest：它会把整个响应缓冲完才返回，
// 用它算 TPS 等于把首字延迟也算进分母，实测能把 300 tok/s 压成 40。
// 这里用 http.request 逐块读 SSE，从「第一个 delta」到「流结束」算生成窗口。
//
// 用法：
//   node tools/measure-speed.mjs --port 8787 --models "a,b,c"
//   node tools/measure-speed.mjs --port 8787            # 不带 --models 则只测占位模型
//
// 输出：单行 JSON，形如
//   {"model-a":{"ttft":1234,"total":4567,"tokens":139,"tps":292.1}, "model-b":{"error":"HTTP 401"}}
import http from "node:http";

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const port = Number(argOf("--port", "8787"));
const host = argOf("--host", "127.0.0.1");
const keyHeader = argOf("--key", "proxy-managed");
const prompt = argOf("--prompt", "Count from 1 to 40. Output only the numbers separated by spaces.");
const maxTokens = Number(argOf("--max-tokens", "400"));
const timeoutMs = Number(argOf("--timeout", "90000"));
const models = argOf("--models", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (models.length === 0) {
  console.error("no --models given");
  process.exit(2);
}

function measure(model) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    });

    const t0 = Date.now();
    let firstDeltaAt = null;
    let usage = null;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    const req = http.request(
      {
        host,
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keyHeader}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let err = "";
          res.on("data", (c) => (err += c));
          res.on("end", () => finish({ error: `HTTP ${res.statusCode}`, detail: err.slice(0, 200) }));
          return;
        }
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith("data:")) continue;
            const payload = s.slice(5).trim();
            if (payload === "[DONE]") continue;
            let j;
            try { j = JSON.parse(payload); } catch { continue; }
            if (j.usage) usage = j.usage;
            const d = j.choices?.[0]?.delta;
            if (d && (d.content || d.reasoning_content) && firstDeltaAt === null) {
              firstDeltaAt = Date.now();
            }
          }
        });
        res.on("end", () => {
          const tEnd = Date.now();
          if (!usage || !usage.completion_tokens) { finish({ error: "no usage in stream" }); return; }
          const tokens = usage.completion_tokens;
          const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
          const genWindow = firstDeltaAt ? tEnd - firstDeltaAt : 0;
          finish({
            ttft: firstDeltaAt ? firstDeltaAt - t0 : null,
            total: tEnd - t0,
            tokens,
            reasoning,
            tps: genWindow > 0 ? Math.round((tokens / (genWindow / 1000)) * 10) / 10 : null,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => { req.destroy(); finish({ error: "timeout" }); });
    req.on("error", (e) => finish({ error: e.message }));
    req.write(body);
    req.end();
  });
}

const out = {};
for (const m of models) out[m] = await measure(m);
console.log(JSON.stringify(out));
