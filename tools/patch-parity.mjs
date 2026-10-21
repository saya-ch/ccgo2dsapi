// patch-parity.mjs —— 让反代的接口行为贴近 DeepSeek 官方 API
//
// 实测差异（对照 https://api-docs.deepseek.com/zh-cn/）：
//   1. /v1/models 缺官方元数据：context_window / max_output_tokens /
//      effort.supported_levels / name / input_modalities / output_modalities
//   2. /v1/models 混入 64 个非 DeepSeek 模型，官方只返回自家模型
//   3. reasoning_effort=none 返回 400，官方 none = 关闭思考
//   4. 错误体缺 error.code（官方有 model_not_found / invalid_request_error 等）
//
// 改的是 node_modules 里的文件，npm install 会覆盖，所以做成可重复执行的脚本。
//
// 用法：
//   node tools/patch-parity.mjs           应用
//   node tools/patch-parity.mjs --check   查看状态
//   node tools/patch-parity.mjs --restore 还原
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);

function findDist() {
  const cfgPath = path.join(repoRoot, "config.json");
  let pkg = "commandcode-api-proxy";
  try {
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (cfg.ProxyPackage) pkg = cfg.ProxyPackage;
    }
  } catch { }
  return path.join(repoRoot, "node_modules", pkg, "dist");
}

const dist = findDist();
const MARKER = "CCGO_PARITY_MODELS";

// ── 定位要改的文件 ─────────────────────────────────────────
const serverFile = path.join(dist, "server.js");
const modelsFile = path.join(dist, "models.json");

if (!fs.existsSync(serverFile)) {
  console.error(`找不到 ${serverFile}\n请先执行 npm install。`);
  process.exit(1);
}

const serverSrc = fs.readFileSync(serverFile, "utf8");
const patched = serverSrc.includes(MARKER);

if (hasFlag("--check")) {
  console.log(`server.js : ${patched ? "已打补丁" : "未打补丁"}`);
  if (patched) {
    const m = serverSrc.match(/const CCGO_PARITY_FILTER = (\/[^/]+\/[a-z]*)/);
    console.log(`过滤器    : ${m ? m[1] : "(默认)"}`);
  }
  // 检查 models.json 是否补了 effort
  try {
    const mj = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
    console.log(`models.json reasoningEfforts.deepseek: ${JSON.stringify(mj.reasoningEfforts?.["deepseek/deepseek-v4-flash"] ?? "无")}`);
  } catch { }
  process.exit(0);
}

if (hasFlag("--restore")) {
  let n = 0;
  for (const f of [serverFile, modelsFile]) {
    const bak = f + ".parity-orig";
    if (fs.existsSync(bak)) { fs.copyFileSync(bak, f); fs.unlinkSync(bak); n++; }
  }
  // 兼容 patch-reasoning 的备份
  console.log(n > 0 ? `已还原 ${n} 个文件。` : "没有可还原的备份。");
  process.exit(0);
}

if (patched) {
  console.log("已经打过补丁，跳过。（要重打请先 --restore，再 npm install）");
  process.exit(0);
}

// ── 1. 改 /v1/models：返回官方风格元数据 + 只留 DeepSeek ────
// 找到 handleModels 里的 OpenAI 分支
const anchor = `    const data = {
        object: "list",
        data: getCatalog().ids.map((id) => ({
            id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "commandcode",
        })),
    };
    sendJson(res, 200, data);`;

if (!serverSrc.includes(anchor)) {
  console.error("找不到 /v1/models 的 OpenAI 分支 —— 反代版本可能变了。");
  console.error("期望片段：\n" + anchor.slice(0, 120) + "...");
  process.exit(1);
}

const replacement = `    // ${MARKER}: 对齐 DeepSeek 官方 /v1/models 的元数据形态。
    // 官方会返回 context_window / max_output_tokens / effort / name /
    // input_modalities 等字段，而 CC 的 provider API 只给 id。
    // catalog 只带 contextWindows/displayNames，maxOutputTokens 从 models.json 读。
    const CCGO_PARITY_FILTER = (process.env.CCGO_MODEL_FILTER || "^deepseek/");
    const CCGO_CTX_DEFAULT = 1048576;      // 官方 Flash 上下文
    const CCGO_MAXOUT_DEFAULT = 393216;    // 官方 Flash 最大输出
    const CCGO_EFFORTS = { supported_levels: ["low", "high", "max"], default_level: "high" };
    const ccCatalog = getCatalog();
    const ccIds = ccCatalog.ids.filter((id) => new RegExp(CCGO_PARITY_FILTER).test(id));
    let ccMaxOut = {};
    try {
        ccMaxOut = modelsData?.maxOutputTokens ?? {};
    } catch { }
    const data = {
        object: "list",
        data: ccIds.map((id) => {
            const ctx = ccCatalog.contextWindows?.[id] ?? CCGO_CTX_DEFAULT;
            const maxOut = ccMaxOut?.[id] ?? CCGO_MAXOUT_DEFAULT;
            return {
                id,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "deepseek",
                name: ccCatalog.displayNames?.[id] ?? id.split("/").pop(),
                context_window: ctx,
                max_output_tokens: maxOut,
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
                effort: CCGO_EFFORTS,
            };
        }),
    };
    sendJson(res, 200, data);`;

let out = serverSrc.replace(anchor, replacement);

// 注入 models.json 的 import（server.js 原本没有），用于取 maxOutputTokens
const importAnchor = `import { formatSSE, formatSSEDone, formatAnthropicSSE } from "./stream.js";`;
const importInjected = `import ccgoModelsData from "./models.json" with { type: "json" };`;
if (!out.includes(importInjected) && out.includes(importAnchor)) {
  out = out.replace(importAnchor, importAnchor + "\n" + importInjected);
  console.log("已注入 models.json import（用于 max_output_tokens）");
}
// 变量名对齐
out = out.replace(/modelsData\?\.maxOutputTokens/g, "ccgoModelsData?.maxOutputTokens");

fs.writeFileSync(serverFile + ".parity-orig", serverSrc, "utf8");
fs.writeFileSync(serverFile, out, "utf8");
console.log(`已改 /v1/models：只返回 DeepSeek + 官方元数据`);
console.log(`  过滤正则: ^deepseek/  （可用环境变量 CCGO_MODEL_FILTER 覆盖）`);
console.log(`  备份: ${serverFile}.parity-orig`);

// ── 2. reasoning_effort: 官方 "none" → 上游 "off" ─────────────
// 官方文档用 none 表示关闭思考，但 CC 上游只接受 off，
// 直接透传会 400。在 toCCRequest 里做一次等价映射。
const openaiFile = path.join(dist, "translate", "openai.js");
let oaSrc = fs.existsSync(openaiFile) ? fs.readFileSync(openaiFile, "utf8") : "";
const EFFORT_MARKER = "CCGO_EFFORT_ALIAS";

if (oaSrc && !oaSrc.includes(EFFORT_MARKER)) {
  // 在 toCCRequest 函数前插入映射函数
  const fnAnchor = "export function toCCRequest(req, configOverrides) {";
  if (oaSrc.includes(fnAnchor)) {
    const helper = `// ${EFFORT_MARKER}: 官方 DeepSeek 用 "none" 关思考，CC 上游只认 "off"。
// 做等价映射，避免用户按官方文档传 none 时被 400 拒绝。
const CCGO_EFFORT_ALIAS = { none: "off", off: "off" };
function ccgoMapEffort(v) {
    if (typeof v !== "string") return v;
    const k = v.toLowerCase();
    return CCGO_EFFORT_ALIAS[k] ?? v;
}

`;
    oaSrc = oaSrc.replace(fnAnchor, helper + fnAnchor);
    // 包住 reasoning_effort 的计算
    const re = /reasoning_effort:\s*resolveEffortForModel\(resolvedModel,\s*([^)]+)\),/;
    const m = oaSrc.match(re);
    if (m) {
      oaSrc = oaSrc.replace(re, `reasoning_effort: resolveEffortForModel(resolvedModel, ccgoMapEffort(${m[1].trim()})),`);
      fs.writeFileSync(openaiFile + ".parity-orig", fs.readFileSync(openaiFile), "utf8");
      fs.writeFileSync(openaiFile, oaSrc, "utf8");
      console.log('已改 reasoning_effort：官方 "none" 自动映射为上游 "off"');
    } else {
      console.warn("找不到 reasoning_effort 赋值行，跳过 none 映射");
    }
  }
} else if (oaSrc.includes(EFFORT_MARKER)) {
  console.log('reasoning_effort 的 none 映射已存在，跳过');
}

// ── 3. 补 models.json 的 reasoningEfforts：加入 low ──────────
// 官方 Flash 支持 low/high/max，而 models.json 只写了 high/max，
// 导致 low 被裁剪成 high。
try {
  const mj = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
  let changed = 0;
  if (mj.reasoningEfforts) {
    for (const id of Object.keys(mj.reasoningEfforts)) {
      if (!/^deepseek\//i.test(id)) continue;
      const cur = mj.reasoningEfforts[id];
      const want = ["low", "high", "max"];
      if (JSON.stringify(cur) !== JSON.stringify(want)) {
        mj.reasoningEfforts[id] = want;
        changed++;
      }
    }
  }
  if (changed > 0) {
    fs.writeFileSync(modelsFile + ".parity-orig", fs.readFileSync(modelsFile), "utf8");
    fs.writeFileSync(modelsFile, JSON.stringify(mj, null, 2), "utf8");
    console.log(`已补 models.json：${changed} 个 DeepSeek 模型的 reasoningEfforts 加入 low 档`);
  } else {
    console.log("models.json 的 reasoningEfforts 已是 low/high/max，无需改");
  }
} catch (e) {
  console.warn("改 models.json 失败（不影响主补丁）:", e.message);
}

// ── 4. usage: 补官方字段 prompt_cache_hit_tokens / miss ───────
// 官方 DeepSeek 返回这两个字段，OpenAI 风格的 cached_tokens 只是近似。
// 上游已给出 cachedTokens，直接换算：hit = cached，miss = prompt - cached。
if (oaSrc.includes("function toOpenAIUsage(u)")) {
  const USAGE_MARKER = "CCGO_CACHE_FIELDS";
  if (!oaSrc.includes(USAGE_MARKER)) {
    const oldUsage = `    if (u.promptTokensDetails?.cachedTokens != null) {
        usage.prompt_tokens_details = { cached_tokens: u.promptTokensDetails.cachedTokens };
    }`;
    const newUsage = `    if (u.promptTokensDetails?.cachedTokens != null) {
        usage.prompt_tokens_details = { cached_tokens: u.promptTokensDetails.cachedTokens };
        // ${USAGE_MARKER}: 对齐 DeepSeek 官方字段名
        const ccgoHit = u.promptTokensDetails.cachedTokens;
        usage.prompt_cache_hit_tokens = ccgoHit;
        usage.prompt_cache_miss_tokens = Math.max(0, promptTokens - ccgoHit);
    }`;
    if (oaSrc.includes(oldUsage)) {
      oaSrc = oaSrc.replace(oldUsage, newUsage);
      fs.writeFileSync(openaiFile, oaSrc, "utf8");
      console.log("已补 usage：prompt_cache_hit_tokens / prompt_cache_miss_tokens");
    } else {
      console.warn("找不到 cached_tokens 片段，跳过 usage 补丁");
    }
  } else {
    console.log("usage 缓存字段已存在，跳过");
  }
}

// ── 5. 错误体：补 error.code ─────────────────────────────────
// 官方错误体是 {error:{message,type,param,code}}，上游错误里其实带了 code
// （如 BAD_REQUEST / FORBIDDEN），透出来即可。
const ERROR_MARKER = "CCGO_ERROR_CODE";
if (!serverSrc.includes(ERROR_MARKER)) {
  const oldErr = `function sendOpenAIError(res, status, message) {
    sendJson(res, status, { error: { message, type: "proxy_error" } });
}`;
  const newErr = `function sendOpenAIError(res, status, message) {
    // ${ERROR_MARKER}: 对齐官方 {error:{message,type,param,code}} 结构。
    // 上游报错文本里通常带 "code":"FORBIDDEN" 之类，抽出来当 error.code。
    const ccgoErr = { message, type: "proxy_error", param: null };
    const m = typeof message === "string" ? message.match(/"code"\\s*:\\s*"([A-Z_]+)"/) : null;
    if (m) ccgoErr.code = m[1];
    else if (status === 404) ccgoErr.code = "not_found";
    else if (status === 401) ccgoErr.code = "invalid_api_key";
    else if (status === 429) ccgoErr.code = "rate_limit_exceeded";
    sendJson(res, status, { error: ccgoErr });
}`;
  if (serverSrc.includes(oldErr)) {
    let fixed = fs.readFileSync(serverFile, "utf8");
    fixed = fixed.replace(oldErr, newErr);
    fs.writeFileSync(serverFile, fixed, "utf8");
    console.log("已补错误体：error.code / error.param");
  } else {
    console.warn("找不到 sendOpenAIError 片段，跳过错误体补丁");
  }
} else {
  console.log("错误体 error.code 已存在，跳过");
}

console.log("");
console.log("重启反代生效：.\\scripts\\stop-proxy.ps1 ; .\\scripts\\start-proxy.ps1 -Hidden");
