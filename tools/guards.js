// 同步护栏。公开产物一旦推上 GitHub Pages 就是全网可见，没有撤回键 —— 所以在写盘前拦。
// 2026-09-01 的教训：join 页面停止展示薪资了，但 jobs.json 里的 min/max 还在，
// 任何人直接打开那个 URL 就能看到。护栏①就是为这种「改了展示、忘了数据」而设。
const fs = require("fs");

const FORBIDDEN = [
  [/Rp\s?[\d.,]/,                "金额 Rp"],
  [/\d+[.,]?\d*\s?(juta|jt)\b/i, "金额 juta/jt"],
  [/\bIDR\b/,                    "金额 IDR"],
  // 只拦「工资词 ± 邻近数字」。「工资发放」是财务岗的职责描述，不是金额
  // —— 2026-09-01 首跑误杀了财务 JD，规则已收窄。
  [/(gaji|salary|薪资|底薪|月薪|工资|提成|佣金)[^。，,.；;]{0,12}\d/i, "工资＋数字"],
  [/\d[^。，,.；;]{0,12}(gaji|salary|薪资|底薪|月薪|工资|提成|佣金)/i, "数字＋工资"],
  [/\bKTP\b|\b\d{16}\b/,         "身份证号"],
  [/\+62\d{8,}|\b08\d{8,}\b/,    "手机号"],
];

// 护栏①：公开文件不得含敏感内容
function guardPublic(name, obj) {
  const s = JSON.stringify(obj);
  for (const [rx, why] of FORBIDDEN) {
    const m = s.match(rx);
    if (m) throw new Error(
      "护栏① 敏感内容：" + name + " 含「" + why + "」→ " + String(m[0]).slice(0, 24) +
      "\n   公开文件不允许出现这类内容，同步已中止。");
  }
}

// 护栏②：变更量熔断。防数据源被误清空导致岗位一夜全下线。
function guardVolume(name, next, prevPath, limit) {
  let prevRaw = null;
  try { prevRaw = fs.readFileSync(prevPath, "utf8"); } catch (e) { return "新建"; }
  let prev; try { prev = JSON.parse(prevRaw); } catch (e) { return "上次产物不可解析"; }
  const a = JSON.stringify(prev).length, b = JSON.stringify(next).length;
  const d = Math.abs(b - a) / Math.max(a, 1);
  const cap = limit == null ? 0.3 : limit;
  if (d > cap) throw new Error(
    "护栏② 变更量熔断：" + name + " 体积变化 " + Math.round(d * 100) + "%（阈值 " + Math.round(cap * 100) + "%）" +
    "\n   数据源可能异常，同步已中止。确认无误后可用 FORCE_SYNC=1 跳过本护栏。");
  return (b >= a ? "+" : "−") + Math.round(d * 100) + "%";
}

// 护栏③：把这次改了什么写进 Actions Summary，出事能倒查
function summary(lines) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  const text = lines.join("\n");
  if (out) { try { fs.appendFileSync(out, text + "\n"); } catch (e) { } }
  return text;
}

// 岗位级 diff：给人看的，不含任何业绩数字
function diffJobs(prevPath, next) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(prevPath, "utf8")); } catch (e) { return ["首次生成，无对比基准"]; }
  const pm = {}, nm = {};
  (prev.jobs || []).forEach(j => pm[j.cn] = j);
  (next.jobs || []).forEach(j => nm[j.cn] = j);
  const rows = [];
  Object.keys(nm).forEach(k => { if (!pm[k]) rows.push("➕ 新开 " + k + "（目标 " + nm[k].goal + "）"); });
  Object.keys(pm).forEach(k => { if (!nm[k]) rows.push("➖ 下线 " + k); });
  Object.keys(nm).forEach(k => {
    if (!pm[k]) return;
    ["goal", "staff", "urgent"].forEach(f => {
      if (String(pm[k][f]) !== String(nm[k][f])) rows.push("✏️ " + k + " · " + f + "：" + pm[k][f] + " → " + nm[k][f]);
    });
    if ((pm[k].jd || "") !== (nm[k].jd || "")) rows.push("✏️ " + k + " · 中文 JD 已改");
    if ((pm[k].jdId || "") !== (nm[k].jdId || "")) rows.push("✏️ " + k + " · 印尼文 JD 已改");
  });
  return rows.length ? rows : ["岗位无变化"];
}

// 护栏④：候选人入口文件数不许骤减。
// j/<slug>.json 是候选人链接的落点 —— 少一个，那位经纪人发出去的链接就拿不到归因码，
// 候选人照样能报名，但简历落库时 Ref 为空，页面上看不出任何异常（2026-09-01 加固）。
function guardEntryCount(dir, nextCount, tolerance) {
  let prev = 0;
  try { prev = fs.readdirSync(dir).filter(f => f.endsWith(".json")).length; } catch (e) { return "新建"; }
  if (prev === 0) return "上次为空";
  const tol = tolerance == null ? 3 : tolerance;
  const lost = prev - nextCount;
  if (lost > tol) throw new Error(
    "护栏④ 入口文件骤减：" + dir + " 由 " + prev + " 个降到 " + nextCount + " 个（少 " + lost + "，容许 " + tol + "）" +
    " · 这些经纪人发出去的链接会拿不到归因码，候选人照样能报名但简历落库时 Ref 为空，页面上看不出异常" +
    " · 同步已中止；若确属正常（批量离职）用 FORCE_SYNC=1 跳过");
  return prev + " → " + nextCount;
}

module.exports = { guardPublic, guardVolume, guardEntryCount, summary, diffJobs, FORBIDDEN };
