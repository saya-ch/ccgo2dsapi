// patch-anthropic.mjs —— 让反代的 Anthropic 端点对齐 DeepSeek 官方协议
//
// 基准：https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/
// 实测差异（对照官方「Anthropic API 兼容性细节」表）：
//
//   1. thinking.budget_tokens >= max_tokens 被直接 400 拒绝。
//      官方明确写「thinking 支持（budget_tokens 被忽略）」，不该报错。
//   2. output_config.effort 完全未处理。官方支持 low/high/max，none 表示关闭思考。
//   3. claude-* 模型名全部映射到「目录里第一个模型」。
//      官方映射规则：claude-opus* → deepseek-v4-pro，
//      claude-sonnet* / claude-haiku* / 其它 claude* → deepseek-flash。
//   4. 未知模型名上游返回 403 FORBIDDEN，官方返回 400。
//
// 用法：
//   node tools/patch-anthropic.mjs            应用
//   node tools/patch-anthropic.mjs --check    查看状态
//   node tools/patch-anthropic.mjs --restore  还原
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
const MARKER = "CCGO_ANTHROPIC";

const files = {
  validation: path.join(dist, "translate", "validation.js"),
  models: path.join(dist, "translate", "anthropic-models.js"),
  anthropic: path.join(dist, "translate", "anthropic.js"),
  server: path.join(dist, "server.js"),
};

for (const [k, f] of Object.entries(files)) {
  if (!fs.existsSync(f)) {
    console.error(`找不到 ${f}`);
    process.exit(1);
  }
}

const read = (f) => fs.readFileSync(f, "utf8");
const writeOrig = (f) => {
  const bak = f + ".anthropic-orig";
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, read(f), "utf8");
};

// ── --check ────────────────────────────────────────────────
if (hasFlag("--check")) {
  for (const [k, f] of Object.entries(files)) {
    console.log(`${k.padEnd(12)} ${read(f).includes(MARKER) ? "已打补丁" : "未打补丁"}`);
  }
  process.exit(0);
}

// ── --restore ──────────────────────────────────────────────
if (hasFlag("--restore")) {
  let n = 0;
  for (const f of Object.values(files)) {
    const bak = f + ".anthropic-orig";
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      fs.unlinkSync(bak);
      n++;
    }
  }
  console.log(n ? `已还原 ${n} 个文件` : "没有可还原的备份");
  process.exit(0);
}

const already = read(files.anthropic).includes(MARKER);
if (already) {
  console.log("已打过补丁，跳过。（要重打先 --restore）");
  process.exit(0);
}

let changed = 0;

// ── 1. 放开 budget_tokens 校验 ──────────────────────────────
{
  const src = read(files.validation);
  const old = `    if (req.thinking && typeof req.thinking === "object") {
        const t = req.thinking;
        if (typeof t.budget_tokens === "number" && t.budget_tokens >= req.max_tokens) {
            throw new ValidationError("thinking.budget_tokens must be less than max_tokens");
        }
    }
`;
  const neu = `    // ${MARKER}: 官方文档写明 thinking 的 budget_tokens 被忽略，
    // 因此不再因 budget_tokens >= max_tokens 而拒绝请求。
`;
  if (!src.includes(old)) {
    console.warn("  ! 未找到 budget_tokens 校验块，跳过该步");
  } else {
    writeOrig(files.validation);
    fs.writeFileSync(files.validation, src.replace(old, neu), "utf8");
    console.log("  1/4 放开 thinking.budget_tokens 校验");
    changed++;
  }
}

// ── 2. claude-* 模型映射 ───────────────────────────────────
{
  const src = read(files.models);
  const old = `export function resolveAnthropicModel(requestedModel) {
    if (!requestedModel.startsWith("claude-")) {
        return resolveModel(requestedModel);
    }
    const envDefault = process.env.ANTHROPIC_DEFAULT_MODEL;
    if (envDefault)
        return resolveModel(envDefault);
    return resolveModel(getDefaultModels()[0]);
}`;
  const neu = `// ${MARKER}: 按官方映射规则处理 claude-* 模型名。
// 官方：claude-opus* -> deepseek-v4-pro；claude-sonnet/haiku 及其它 claude* -> deepseek-flash。
// 原实现把所有 claude-* 都指向目录里的第一个模型，与官方不一致。
const CCGO_CLAUDE_MAP = [
    [/^claude-opus/i, "deepseek/deepseek-v4-pro"],
    [/^claude-(sonnet|haiku|fable)/i, "deepseek/deepseek-v4-flash"],
    [/^claude/i, "deepseek/deepseek-v4-flash"],
];
export function resolveAnthropicModel(requestedModel) {
    if (!requestedModel.startsWith("claude-")) {
        return resolveModel(requestedModel);
    }
    const envDefault = process.env.ANTHROPIC_DEFAULT_MODEL;
    if (envDefault)
        return resolveModel(envDefault);
    for (const [re, target] of CCGO_CLAUDE_MAP) {
        if (re.test(requestedModel))
            return resolveModel(target);
    }
    return resolveModel(getDefaultModels()[0]);
}`;
  if (!src.includes(old)) {
    console.warn("  ! 未找到 resolveAnthropicModel，跳过该步");
  } else {
    writeOrig(files.models);
    fs.writeFileSync(files.models, src.replace(old, neu), "utf8");
    console.log("  2/4 按官方规则映射 claude-* 模型名");
    changed++;
  }
}

// ── 3. output_config.effort 与 thinking 语义 ────────────────
{
  const src = read(files.anthropic);

  // 3a. 插入 effort 解析函数
  const anchorFn = "function resolveReasoningEffort(thinking) {";
  const helper = `// ${MARKER}: 官方 Anthropic 协议的思考控制在两个字段里：
//   thinking: { type: "enabled" | "disabled" }   —— 开关
//   output_config: { effort: "low" | "high" | "max" } —— 强度，none 表示关闭
// output_config 优先；其次看 thinking。budget_tokens 官方忽略。
function ccgoResolveEffort(req) {
    const oc = req && req.output_config;
    const eff = oc && typeof oc === "object" ? oc.effort : undefined;
    if (typeof eff === "string" && eff.length > 0) {
        const k = eff.toLowerCase();
        return k === "none" ? "off" : k;
    }
    const t = req && req.thinking;
    if (!t || typeof t !== "object")
        return undefined;
    if (t.type === "disabled")
        return "off";
    if (t.type === "enabled") {
        // 有 budget 就按预算折算档位；没有就交回上游默认
        return typeof t.budget_tokens === "number" ? resolveReasoningEffort(t) : undefined;
    }
    return undefined;
}

`;
  if (src.includes(anchorFn) && !src.includes("ccgoResolveEffort")) {
    var src2 = src.replace(anchorFn, helper + anchorFn);
  } else {
    var src2 = src;
    if (!src.includes(anchorFn)) console.warn("  ! 未找到 resolveReasoningEffort，跳过注入");
  }

  // 3b. 替换调用处
  // 注意：resolveEffortForModel 会把 "off" 裁剪成最近的合法档位（high），
  // 所以关闭语义必须直接透传，不能进裁剪函数。
  const oldCall = "reasoning_effort: resolveEffortForModel(resolvedModel, resolveReasoningEffort(req.thinking)),";
  const newCall = `reasoning_effort: (() => {
                const want = ccgoResolveEffort(req);
                if (typeof want === "string" && want.toLowerCase() === "off")
                    return "off";
                return resolveEffortForModel(resolvedModel, want);
            })(),`;
  if (!src2.includes(oldCall)) {
    console.warn("  ! 未找到 reasoning_effort 赋值行，跳过该步");
  } else {
    src2 = src2.replace(oldCall, newCall);
    writeOrig(files.anthropic);
    fs.writeFileSync(files.anthropic, src2, "utf8");
    console.log("  3/4 支持 output_config.effort 与 thinking 开关语义（off 直接透传）");
    changed++;
  }
}

// ── 4. 未知模型 403 → 400 ──────────────────────────────────
{
  const src = read(files.server);
  const oldAnth = `        if (err instanceof UpstreamError) {
            const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
            const type = ANTHROPIC_STATUS_ERROR_MAP[status] ?? "api_error";
            sendAnthropicError(res, status, type, err.message);
        }`;
  const newAnth = `        if (err instanceof UpstreamError) {
            let status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
            // ${MARKER}: 官方对未知模型返回 400，上游返回 403，这里归一
            if (status === 403 && /not recognized|not found|unknown model/i.test(String(err.message)))
                status = 400;
            const type = ANTHROPIC_STATUS_ERROR_MAP[status] ?? "api_error";
            sendAnthropicError(res, status, type, err.message);
        }`;
  const oldOAI = `    if (err instanceof UpstreamError) {
        const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
        sendOpenAIError(res, status, err.message);
    }`;
  const newOAI = `    if (err instanceof UpstreamError) {
        let status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 502;
        // ${MARKER}: 官方对未知模型返回 400，上游返回 403，这里归一
        if (status === 403 && /not recognized|not found|unknown model/i.test(String(err.message)))
            status = 400;
        sendOpenAIError(res, status, err.message);
    }`;

  let s2 = src;
  let ok = 0;
  if (s2.includes(oldAnth)) { s2 = s2.replace(oldAnth, newAnth); ok++; }
  if (s2.includes(oldOAI)) { s2 = s2.replace(oldOAI, newOAI); ok++; }
  if (ok === 2) {
    writeOrig(files.server);
    fs.writeFileSync(files.server, s2, "utf8");
    console.log("  4/4 未知模型错误码 403 -> 400");
    changed++;
  } else {
    console.warn(`  ! 错误映射只匹配到 ${ok}/2 处，跳过该步`);
  }
}

console.log(`\n完成 ${changed}/4 步。重启反代生效：`);
console.log("  .\\scripts\\stop-proxy.ps1 ; .\\scripts\\start-proxy.ps1 -Hidden");

// 锚点失配意味着补丁没打全，不能让安装脚本以为成功
if (changed < 4) {
  console.error(`\nx 只应用了 ${changed}/4 步 —— 上游 dist 可能已变更，请检查锚点`);
  process.exit(1);
}
