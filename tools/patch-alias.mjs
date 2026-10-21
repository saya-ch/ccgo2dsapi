// patch-alias.mjs —— 让短模型名指向官方语义对应的模型
//
// 背景：DeepSeek 官方文档写明
//   模型名请使用 deepseek-flash。旧模型名 deepseek-v4-flash 仍可调用，
//   但对应模型已下线，请求由 DeepSeek-V4.1-Flash-1017 提供服务。
// 也就是说官方的 deepseek-flash == V4.1-Flash。
//
// commandcode-api-proxy 的 models.json 把 deepseek-flash 映射到了
// deepseek/deepseek-v4-flash（旧版），与官方语义不一致。上游把这两个
// 当成不同模型（catalog 里 v4-flash 与 v4.1-flash 是两个独立条目），
// 所以必须显式纠正，否则「deepseek-flash」跑的是旧模型。
//
// 用法：
//   node tools/patch-alias.mjs            应用
//   node tools/patch-alias.mjs --check    查看状态
//   node tools/patch-alias.mjs --restore  还原
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
const modelsFile = path.join(dist, "models.json");
if (!fs.existsSync(modelsFile)) {
  console.error(`找不到 ${modelsFile}，请先 npm install`);
  process.exit(1);
}

const MARKER = "_ccgoAliasPatch";

// 只改「官方语义明确」的那一个别名。
// 注意：不要动 deepseek-v4-flash —— 它是上游真实存在的独立模型，
// 把它重定向到 v4.1 会导致 v4-flash 再也调不到。
const FLASH_ALIAS = "deepseek-flash";
const FLASH_TARGET = "deepseek/deepseek-v4.1-flash";

// 补上官方文档用到、原表里缺失的 v4.1 写法
const EXTRA_ALIASES = {
  "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
  "deepseek-v4.1-flash-fast": "deepseek/deepseek-v4.1-flash-fast",
};

const raw = fs.readFileSync(modelsFile, "utf8");
const data = JSON.parse(raw);

if (hasFlag("--check")) {
  const cur = data.shortAliases?.[FLASH_ALIAS];
  console.log(`${FLASH_ALIAS}  -> ${cur}`);
  console.log(`目标                   ${FLASH_TARGET}`);
  console.log(`状态: ${cur === FLASH_TARGET ? "已对齐官方语义" : "未对齐"}`);
  for (const k of Object.keys(EXTRA_ALIASES)) {
    console.log(`${k.padEnd(22)} -> ${data.shortAliases?.[k] ?? "缺失"}`);
  }
  process.exit(0);
}

if (hasFlag("--restore")) {
  const bak = modelsFile + ".alias-orig";
  if (!fs.existsSync(bak)) {
    console.log("没有备份可还原（重新 npm install 亦可恢复原状）");
    process.exit(0);
  }
  fs.copyFileSync(bak, modelsFile);
  fs.unlinkSync(bak);
  console.log("已还原 models.json");
  process.exit(0);
}

// 应用
if (!data.shortAliases) {
  console.error("models.json 里没有 shortAliases");
  process.exit(1);
}

if (!fs.existsSync(modelsFile + ".alias-orig")) {
  fs.writeFileSync(modelsFile + ".alias-orig", raw, "utf8");
}

let changed = 0;
if (data.shortAliases[FLASH_ALIAS] !== FLASH_TARGET) {
  data.shortAliases[FLASH_ALIAS] = FLASH_TARGET;
  changed++;
}
for (const [k, v] of Object.entries(EXTRA_ALIASES)) {
  if (data.shortAliases[k] !== v) {
    data.shortAliases[k] = v;
    changed++;
  }
}

data[MARKER] = {
  applied: new Date().toISOString(),
  note: "官方语义：deepseek-flash == DeepSeek-V4.1-Flash；v4-flash 保持独立不动",
  flashTarget: FLASH_TARGET,
};

fs.writeFileSync(modelsFile, JSON.stringify(data, null, 2) + "\n", "utf8");

console.log(`已更新 ${changed} 个别名`);
console.log(`  ${FLASH_ALIAS.padEnd(24)} -> ${FLASH_TARGET}`);
for (const [k, v] of Object.entries(EXTRA_ALIASES)) {
  console.log(`  ${k.padEnd(24)} -> ${v}`);
}
console.log("  deepseek-v4-flash        -> 保持原样（上游独立模型，不重定向）");
console.log(`\n备份: ${modelsFile}.alias-orig`);
console.log("重启反代生效：.\\scripts\\stop-proxy.ps1 ; .\\scripts\\start-proxy.ps1 -Hidden");
