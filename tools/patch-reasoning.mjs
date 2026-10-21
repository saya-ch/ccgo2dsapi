// patch-reasoning.mjs —— 让反代默认带上 reasoning_effort
//
// 背景：CC 的 /alpha/generate 只有在请求里带 reasoning_effort 时才会产生推理内容。
// 不带的话上游 reasoningTokens=0，客户端永远收不到 reasoning_content，界面上就看不到 CoT。
//
// 这个补丁让反代在客户端没指定时默认发 high。
// 因为它改的是 node_modules 里的文件，npm install / 升级后会失效，
// 所以做成可重复执行的脚本：install 后跑一次即可。
//
// 用法：
//   node tools/patch-reasoning.mjs              # 应用（默认 high）
//   node tools/patch-reasoning.mjs --effort max # 换成 max
//   node tools/patch-reasoning.mjs --restore    # 还原
//   node tools/patch-reasoning.mjs --check      # 只检查是否已打补丁
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

// 定位反代包
function findProxyDir() {
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

const distDir = findProxyDir();
const target = path.join(distDir, "translate", "openai.js");
const backup = target + ".orig";

if (!fs.existsSync(target)) {
  console.error(`找不到 ${target}`);
  console.error("请先执行 npm install。");
  process.exit(1);
}

const MARKER = "CCGO_REASONING_DEFAULT";
const src = fs.readFileSync(target, "utf8");
const alreadyPatched = src.includes(MARKER);

function check() {
  console.log(`target  : ${target}`);
  console.log(`patched : ${alreadyPatched}`);
  if (alreadyPatched) {
    const m = src.match(/const CCGO_REASONING_DEFAULT = "([^"]+)"/);
    console.log(`effort  : ${m ? m[1] : "?"}`);
  }
  process.exit(0);
}

function restore() {
  if (!fs.existsSync(backup)) {
    console.error(`没有备份文件 ${backup}，无法还原。重新 npm install 即可恢复原状。`);
    process.exit(1);
  }
  fs.copyFileSync(backup, target);
  fs.unlinkSync(backup);
  console.log("已还原为原始实现。");
  process.exit(0);
}

function apply(effort) {
  if (alreadyPatched) {
    console.log(`已经打过补丁（effort=${(src.match(/CCGO_REASONING_DEFAULT = "([^"]+)"/) || [])[1]}），跳过。`);
    console.log("要改级别：先 --restore，再重新应用。");
    return;
  }

  const anchor = "export function toCCRequest(req, configOverrides) {";
  if (!src.includes(anchor)) {
    console.error("找不到 toCCRequest 函数 —— 反代版本可能变了，请检查。");
    process.exit(1);
  }

  // 1) 在函数前插入默认值常量 + off 透传辅助
  const header = `// ${MARKER}: 客户端没给 reasoning_effort 时的默认值。
// 不带这个参数上游不会产生推理内容，客户端就收不到 reasoning_content。
// 设为 "auto" 可恢复原始行为（完全透传客户端）。
const CCGO_REASONING_DEFAULT = "${effort}";

// 上游用 "off" 表示不推理，但 resolveEffortForModel 会把不支持的级别
// 裁剪到最近的合法值，于是 "off" 被改写成 "high"，等于关不掉推理。
// 这里把关闭语义直接透传，不走裁剪。
const CCGO_REASONING_OFF = new Set(["off", "none", "disabled", "false"]);

`;

  let out = src.replace(anchor, header + anchor);

  // 2) 把 reasoning_effort 那行换成带默认值 + off 透传的版本
  const oldLine = "reasoning_effort: resolveEffortForModel(resolvedModel, req.reasoning_effort),";
  const newLine =
    "reasoning_effort: (() => {\n" +
    "                const want = req.reasoning_effort ?? " +
    '(CCGO_REASONING_DEFAULT === "auto" ? undefined : CCGO_REASONING_DEFAULT);\n' +
    "                // 官方 DeepSeek 用 none 表示关闭思考，CC 上游只认 off，统一映射成 off\n" +
    "                if (typeof want === \"string\" && CCGO_REASONING_OFF.has(want.toLowerCase())) return \"off\";\n" +
    "                return resolveEffortForModel(resolvedModel, want);\n" +
    "            })(),";
  if (!out.includes(oldLine)) {
    console.error("找不到 reasoning_effort 赋值行 —— 反代版本可能变了，请检查。");
    process.exit(1);
  }
  out = out.replace(oldLine, newLine);

  fs.copyFileSync(target, backup);
  fs.writeFileSync(target, out, "utf8");
  console.log(`已打补丁：默认 reasoning_effort = "${effort}"，off/none 直接透传`);
  console.log(`备份：${backup}`);
  console.log("");
  console.log("重启反代生效：.\\scripts\\stop-proxy.ps1 ; .\\scripts\\start-proxy.ps1 -Hidden");
}

if (hasFlag("--check")) check();
else if (hasFlag("--restore")) restore();
else apply((argOf("--effort", "high") || "high").toLowerCase());
