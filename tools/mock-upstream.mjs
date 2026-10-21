// tools/mock-upstream.mjs —— 本地 mock 上游，用于离线验证协议翻译
//
// 为什么不直接连真上游验证：
//   每次 verify 都要消耗套餐额度，改一行代码跑一遍验证，一晚上能烧掉大半周额度。
//   协议翻译层的正确性（字段映射、事件序列、错误结构）不依赖真实模型 ——
//   只要事件流形状对，翻译结果就该对。
//
// 用法：
//   node tools/mock-upstream.mjs --port 8799
//   node tools/mock-upstream.mjs --port 8799 --fixture tools/fixtures/basic.ndjson
//
// 然后让网关指向它：
//   node vendor/server.mjs --port 8899 --base http://127.0.0.1:8799
//   node tools/verify-all.mjs 8899

import http from "node:http";

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const PORT = Number(argOf("--port", "8799"));
const HOST = argOf("--host", "127.0.0.1");

// ── 场景：根据请求内容决定回放哪些事件 ────────────────────
// 每个场景产出标准的上游 NDJSON 事件序列。
function buildScenario(body) {
  const params = body.params || {};
  const model = params.model || "";
  const messages = params.messages || [];
  const hasTools = Array.isArray(params.tools) && params.tools.length > 0;

  // 最后一条 user 消息的文本，用来判断场景
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = typeof lastUser?.content === "string"
    ? lastUser.content
    : (lastUser?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const hasImage = (lastUser?.content || []).some?.((c) => c.type === "image");

  const usage = (inTok, outTok, reasoning = 0, cacheRead = 0) => ({
    inputTokens: inTok,
    inputTokenDetails: { noCacheTokens: inTok - cacheRead, cacheReadTokens: cacheRead },
    outputTokens: outTok,
    outputTokenDetails: { textTokens: outTok - reasoning, reasoningTokens: reasoning },
    totalTokens: inTok + outTok,
    reasoningTokens: reasoning,
    cachedInputTokens: cacheRead,
  });

  // 1. 明确要求截断（用很小的 max_tokens）
  if (params.max_tokens && params.max_tokens <= 60) {
    return [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-delta", text: "这是一段会被截" },
      { type: "finish", finishReason: "length", rawFinishReason: "length",
        totalUsage: usage(40, 20) },
    ];
  }

  // 2. 工具调用
  if (hasTools) {
    return [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "reasoning-start", id: "r-0" },
      { type: "reasoning-delta", id: "r-0", text: "需要查天气" },
      { type: "reasoning-end", id: "r-0" },
      { type: "tool-call", toolCallId: "call_mock_1", toolName: params.tools[0].name,
        input: { city: "北京" } },
      { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool_calls",
        totalUsage: usage(120, 30, 12) },
    ];
  }

  // 3. 图片输入
  if (hasImage) {
    return [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-delta", text: "红蓝" },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop",
        totalUsage: usage(1500, 5) },
    ];
  }

  // 4. 要求思考：只看提示词意图和「显式关闭」。
  // 不能用 reasoning_effort 是否存在来判断 —— 网关默认就给 high，
  // 那样所有请求都会被判成要思考，mock 就失去了分场景的意义。
  const effortOff = params.reasoning_effort === "off";
  const wantsThinking = !effortOff && /计算|解释|推理|分析|why|explain/i.test(lastText);

  if (wantsThinking) {
    return [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "reasoning-start", id: "r-0" },
      { type: "reasoning-delta", id: "r-0", text: "先算 17 乘 23，等于 391。" },
      { type: "reasoning-end", id: "r-0" },
      { type: "text-delta", text: "17 × 23 = 391" },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop",
        totalUsage: usage(60, 25, 20) },
    ];
  }

  // 5. 默认：简单回声
  const echo = /say|reply|exactly/i.test(lastText) ? "OK" : "MOCK_RESPONSE";
  return [
    { type: "start" },
    { type: "start-step", request: {}, warnings: [] },
    { type: "text-delta", text: echo },
    { type: "finish", finishReason: "stop", rawFinishReason: "stop",
      totalUsage: usage(35, 8) },
  ];
}

function sseBody(events) {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

// ── 服务 ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = (req.url || "").split("?")[0];

  // 额度接口
  if (url === "/alpha/billing/credits") {
    const body = JSON.stringify({
      credits: {
        planId: "individual-go-v1",
        monthlyCredits: 8.5,
        purchasedCredits: 0,
        freeCredits: 0,
        windowLimits: {
          fiveHour: { used: 0.42, cap: 3, resetAt: Date.now() + 3600_000 },
          weekly: { used: 1.2, cap: 6, resetAt: Date.now() + 86400_000 * 3 },
        },
      },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }

  if (url === "/alpha/billing/subscriptions") {
    const body = JSON.stringify({
      planId: "individual-go-v1",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 86400_000 * 20).toISOString(),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }

  if (url === "/provider/v1/models") {
    const body = JSON.stringify({
      data: [
        { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1000000 },
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_length: 1000000 },
        { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context_length: 1000000 },
      ],
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }

  // 生成端点
  if (url === "/alpha/generate" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { }

      const scenario = argOf("--scenario", "");
      let events;
      if (scenario === "error") {
        events = [{ type: "error", error: { message: "mock upstream failure", statusCode: 500 } }];
      } else if (scenario === "truncated") {
        // 不 finish、不 abort —— 流被截断
        events = [
          { type: "start" },
          { type: "text-delta", text: "这段没有 finish" },
        ];
      } else if (scenario === "abort") {
        events = [
          { type: "start" },
          { type: "text-delta", text: "被取消" },
          { type: "abort" },
        ];
      } else {
        events = buildScenario(body);
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      });

      // 逐事件写出，模拟真实流式节奏
      let i = 0;
      const tick = () => {
        if (i >= events.length) return res.end();
        res.write(JSON.stringify(events[i++]) + "\n");
        setTimeout(tick, 5);
      };
      tick();
    });
    return;
  }

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", mock: true }));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "mock: no route " + url } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[mock] listening on http://${HOST}:${PORT}`);
  console.log(`[mock]   POST /alpha/generate`);
  console.log(`[mock]   GET  /alpha/billing/credits`);
  console.log(`[mock]   GET  /provider/v1/models`);
});
