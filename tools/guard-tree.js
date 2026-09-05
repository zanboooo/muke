#!/usr/bin/env node
// 公开库污染护栏。扫的是「要进这个仓库的文件」，不是「同步脚本生成的产物」——
// guards.js 的 guardPublic 只看 sync-portal 写出的 JSON，手工放进来的 HTML、脚本、
// 文档一律绕过它。2026-09-06 删库重建前的四处泄露全部走的是这条绕行路径：
//   hb-85228748b9/index.html（真实薪档，手工新建）
//   kalkulator/index.html（硬编码真实试用期月薪，÷173 可反推）
//   h01demo/index.html（一个真实号段的工号 —— 工号是员工名册解密的第二因子）
//   dayldemo/examdemo（与真人重名的演示数据）
//
// 用法
//   node tools/guard-tree.js            扫暂存区（pre-commit 钩子调这个）
//   node tools/guard-tree.js --all      扫全树（CI 调这个）
//   node tools/guard-tree.js --all -v   连命中的原文一起打（**只在本机跑，别进 CI 日志**）
//
// ⚠ 这个文件本身在公开库里 —— 所以它只能写「形状」，不能写任何真值。
//   没有真实姓名表、没有真实工号、没有 app_token。要按真值比对的那一层在
//   `AI CEO/tools/` 里，那边是私有的。

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ALL = process.argv.includes("--all");
const VERBOSE = process.argv.includes("-v") || process.argv.includes("--verbose");

// ── 规则。每条 [id, 正则, 人话, 为什么] ──────────────────────────
// id 用于 .guardignore 精确豁免某文件的某一条，不是整个文件开天窗。
const RULES = [
  ["money-rp", /Rp\s?[\d.][\d.,]{4,}/, "金额 Rp",
    "工资结构不进任何仓库。时薪 ×173 就能反推出月薪档位"],
  ["money-juta", /\b\d+[.,]?\d*\s?(juta|jt)\b/i, "金额 juta/jt", "同上"],
  ["money-idr", /\bIDR\s?[\d.]/, "金额 IDR", "同上"],
  // 邻近数字必须像「金额」：≥5 位，或带千分位。否则「薪资区间已于 2026-09-01 下线」
  // 这种说明文字会被年份触发（2026-09-06 首跑误杀 3 处）。
  ["salary-word", /(gaji|salary|薪资|底薪|月薪|工资|提成|佣金)[^。，,.；;\n]{0,12}(\d[\d.,]{4,}|\d{1,3}([.,]\d{3})+)/i, "工资词＋金额",
    "只拦邻近数字。「工资发放」是财务岗职责描述，不算"],
  ["salary-word2", /(\d[\d.,]{4,}|\d{1,3}([.,]\d{3})+)[^。，,.；;\n]{0,12}(gaji|salary|薪资|底薪|月薪|工资|提成|佣金)/i, "金额＋工资词", "同上"],
  ["ump", /\bUMP\b/, "UMP 字样", "雅加达最低工资，出现即意味着在谈薪档对比"],

  // 只拦号码，不拦「KTP」这个词 —— 候选人界面的印尼语文案里它是合法词
  //（"Tulis persis seperti di KTP" = 照身份证原样填）。2026-09-06 首跑误杀 4 处。
  ["ktp", /\bKTP\s*(NIK|No\.?|Number)?\s*[:=]?\s*\d{6,}|(?<![\d.\-])\d{16}(?![\d.\-])/, "身份证号", "印尼 KTP 是 16 位"],
  // 08123456789(0) 是印尼表单的通用占位示例，不是真号 —— 排除，否则表单提示必然误杀。
  ["phone-id", /\+62\d{8,}|(?<![\d.])08(?!1234567890?\b)\d{8,}(?![\d.])/, "印尼手机号",
    "手机号后 9 位是员工名册解密的第一因子"],
  ["emp-no", /\bMK2[01]\d\d\b/, "真实工号号段 MK20xx/MK21xx",
    "工号是名册解密的第二因子。演示数据一律用 MK90xx"],
  ["email", /[A-Za-z0-9._%+-]+@(?!example\.|test\.|muke\.test)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "邮箱地址",
    "员工邮箱＝可定位到人。演示用 @example.com"],

  ["lark-appid", /\bcli_[A-Za-z0-9]{12,}\b/, "Lark app_id", "凭据"],
  ["lark-id", /\bo[cune]_[0-9a-f]{28,}\b/, "Lark 群/人 open_id",
    "oc_ 是群、ou_ 是人。都是可直接调 API 的标识符"],
  ["gh-token", /\bghp_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "GitHub token", "凭据"],
  ["privkey", /-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥", "凭据"],
  ["secret-assign", /(secret|password|passwd|api[_-]?key|access[_-]?token|app_secret)\s*[:=]\s*["'`][^"'`\s]{12,}/i,
    "疑似硬编码凭据", "赋值形态的密钥。用环境变量，别写进文件"],
];

// ── 豁免。格式：<路径前缀> <规则id,规则id> # 理由 ──────────────
// 只豁免指定文件的指定规则，不给整个文件开天窗；没写理由的行直接报错。
function loadIgnore() {
  const p = path.join(ROOT, ".guardignore");
  let raw = ""; try { raw = fs.readFileSync(p, "utf8"); } catch (e) { return []; }
  return raw.split(/\r?\n/).map((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith("#")) return null;
    const hash = s.indexOf("#");
    if (hash < 0) throw new Error(`.guardignore 第 ${i + 1} 行没写理由（# 后面）：${s}`);
    const [file, ids] = s.slice(0, hash).trim().split(/\s+/);
    if (!file || !ids) throw new Error(`.guardignore 第 ${i + 1} 行格式应为「路径 规则id[,规则id] # 理由」：${s}`);
    return { file, ids: ids.split(","), why: s.slice(hash + 1).trim() };
  }).filter(Boolean);
}

const SKIP_DIR = /(^|\/)(\.git|node_modules|avatar\/vendor)(\/|$)/;
const BINARY = /\.(png|jpe?g|gif|webp|mp4|webm|woff2?|ttf|otf|ico|pdf|zip|onnx|wasm|bin)$/i;
const RE_B64 = new RegExp("data:[a-z0-9.+-]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{40,}", "gi");

function targets() {
  if (ALL) {
    const out = [];
    (function walk(d) {
      for (const f of fs.readdirSync(d)) {
        const abs = path.join(d, f);
        const rel = path.relative(ROOT, abs).split(path.sep).join("/");
        if (SKIP_DIR.test(rel) || rel === ".git") continue;
        if (fs.statSync(abs).isDirectory()) walk(abs); else out.push(rel);
      }
    })(ROOT);
    return out;
  }
  // 暂存区：只看新增/修改的，删除的不用扫
  const raw = execSync("git diff --cached --name-only --diff-filter=ACM", { cwd: ROOT, encoding: "utf8" });
  return raw.split(/\r?\n/).filter(Boolean).map((s) => s.split(path.sep).join("/"));
}

function main() {
  const ignores = loadIgnore();
  const files = targets().filter((f) => !SKIP_DIR.test(f) && !BINARY.test(f));
  const hits = [];

  for (const rel of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch (e) { continue; }
    if (text.indexOf("\u0000") >= 0) continue;              // 二进制漏网的
    const waived = ignores.filter((g) => rel === g.file || rel.startsWith(g.file.replace(/\/$/, "") + "/"));
    const waivedIds = new Set(waived.flatMap((g) => g.ids));

    // base64 数据 URI 是不透明二进制，不该当文本审计 —— 里面必然出现各种字母组合，
    // 2026-09-06 首扫 MSOP 就被一张内嵌 webp 里的 jt 误判成金额。剥掉再扫。
    text = text.replace(RE_B64, "data:<base64 已剥离>");
    text.split(/\r?\n/).forEach((line, n) => {
      // 同行标记豁免：写 `guard-tree:allow <规则id> <理由>`，理由必填
      const inline = line.match(/guard-tree:allow\s+([a-z0-9,-]+)\s+(\S.*)$/);
      const inlineIds = new Set(inline ? inline[1].split(",") : []);
      for (const [id, rx, what] of RULES) {
        if (waivedIds.has(id) || inlineIds.has(id)) continue;
        const m = line.match(rx);
        if (m) hits.push({ rel, n: n + 1, id, what, sample: String(m[0]).slice(0, 30) });
      }
    });
  }

  const scope = ALL ? `全树 ${files.length} 个文本文件` : `暂存区 ${files.length} 个文件`;
  if (!hits.length) { console.log(`✅ 公开库护栏：${scope}，未发现隐私数据或凭据`); return 0; }

  console.error(`\n🔴 公开库护栏拦截：${scope}，${hits.length} 处命中\n`);
  const byFile = {};
  hits.forEach((h) => { (byFile[h.rel] = byFile[h.rel] || []).push(h); });
  for (const [rel, hs] of Object.entries(byFile)) {
    console.error("  " + rel);
    hs.slice(0, 8).forEach((h) => console.error(
      `    第 ${h.n} 行  [${h.id}] ${h.what}` + (VERBOSE ? `  → ${h.sample}` : "")));
    if (hs.length > 8) console.error(`    …另有 ${hs.length - 8} 处`);
  }
  console.error(`
  这是一个 **public 仓库**，推上去就是全网可见，而且删文件删不掉历史 ——
  git rm 只加一个删除提交，文件仍在之前每一个提交的树里，GitHub 会一直按 SHA 提供它。
  2026-09-06 就为这件事删库重建过一次。

  三条出路，按优先级：
    1. 把那段内容拿掉，或换成虚构数据（工号用 MK90xx，邮箱用 @example.com）
    2. 真值改走环境变量 / GitHub Secrets，文件里只留变量名
    3. 确认是误杀 → 在 .guardignore 里写一行「路径 规则id # 理由」，
       或在那一行末尾加注释 guard-tree:allow <规则id> <理由>。理由必填。

  ⛔ 不要用 git commit --no-verify 绕过。绕过的代价是再删一次库。
`);
  return 1;
}

process.exit(main());
