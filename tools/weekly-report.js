// 报名周报（WO-0275）：每周一早上把「上周报名情况」发进 Lark 群。
//
// 时间窗＝完整自然周（上周一 00:00 至本周一 00:00，雅加达），不是「近 7 天」——
// 每期不重不漏，期与期之间可直接比较。
//
// 三个重点（张博 2026-09-04 定）：上周报名情况、哪些经纪人突出、人从什么渠道来。
//
// 口径全部复用线上已定案的列，不另算一套：
//   · 简历数 —— A05 按 Created_Time 落在窗口内计数
//   · 经纪人归属 —— 直接读 A05.Agent（lookup），它能把旧岗位码也解析成人（Ref=8BA4 → Rai）
//   · 质量指标 —— A02.Pass%（累计二面通过率），量看上周、质看累计，两者一起才看得出谁真突出
//   · 累计漏斗 —— A02 各列求和（经纪人口径）
// 发送失败不抛错，周报挂了不该把 workflow 弄红。
const { J, auth } = require("./_net.js");
const NOTIFY = require("./notify.js");

const APP = process.env.LARK_BASE_TOKEN;
if (!APP) { console.error("🔴 缺 LARK_BASE_TOKEN"); process.exit(1); }
const A05 = "tblyxgrrFk1Jzy6e", A02 = "tblIiWloAPiwkN8M";
const DAY = 86400e3, TZ = 7 * 3600e3;

const V = (v) => {
  if (v == null) return "";
  const a = (v && v.value !== undefined) ? v.value : v;
  if (Array.isArray(a)) return a.map((x) => (x && (x.text || x.name)) || x).filter(Boolean).join("");
  if (typeof a === "object") return String(a.text || a.name || "");
  return String(a);
};
const PN = (a) => (Array.isArray(a) && a[0]) ? (a[0].en_name || a[0].name || "") : "";
const N = (v) => { const x = parseFloat(V(v)); return isNaN(x) ? 0 : x; };
const jkt = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);

// 上周一 00:00（雅加达）的毫秒时间戳。周日算上一周的最后一天。
function lastMonday(now) {
  const d = new Date(now + TZ);
  const dow = d.getUTCDay() || 7;                       // 周一=1 … 周日=7
  const thisMon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (dow - 1)) - TZ;
  return thisMon - 7 * DAY;
}

const pull = async (H, t) => {
  let r = [], pt, guard = 0;
  do {
    const q = await J(H, "POST", `/open-apis/bitable/v1/apps/${APP}/tables/${t}/records/search?page_size=500` + (pt ? "&page_token=" + pt : ""), {});
    if (!q.data) throw new Error("拉取失败 " + t + " code=" + q.code);
    r = r.concat(q.data.items || []); pt = q.data.page_token;
  } while (pt && ++guard < 20);
  return r;
};

const bar = (n, max, w) => { const k = max > 0 ? Math.round(n / max * (w || 10)) : 0; return "▇".repeat(Math.max(n > 0 ? 1 : 0, k)); };
const pct = (a, b) => (b > 0 ? Math.round(a / b * 100) : 0);
const delta = (cur, prev) => {
  if (prev === 0) return cur > 0 ? "（前一周 0）" : "（前一周也是 0）";
  const d = Math.round((cur - prev) / prev * 100);
  return "（前一周 " + prev + (d === 0 ? "，持平）" : "，" + (d > 0 ? "↑" : "↓") + Math.abs(d) + "%）");
};

(async () => {
  const H = await auth();
  const [a05, a02] = await Promise.all([pull(H, A05), pull(H, A02)]);

  const now = Date.now();
  const from = lastMonday(now), to = from + 7 * DAY, prevFrom = from - 7 * DAY;
  const inWin = (r, lo, hi) => { const t = N(r.fields["Created_Time"]); return t > 1e11 && t >= lo && t < hi; };
  const cur = a05.filter((r) => inWin(r, from, to));
  const prev = a05.filter((r) => inWin(r, prevFrom, from));


  const tally = (rows, get) => {
    const o = {};
    rows.forEach((r) => { const k = get(r) || "（未标记）"; o[k] = (o[k] || 0) + 1; });
    return Object.entries(o).sort((a, b) => b[1] - a[1]);
  };
  const byChannel = tally(cur, (r) => V(r.fields.Kanal));
  const byJob = tally(cur, (r) => V(r.fields["Job-CN"]));
  // A05.Agent 是 lookup，已把归因码（含旧岗位码）解析成人，比自己拿 ARef 反查可靠
  const byAgent = tally(cur, (r) => V(r.fields.Agent) || (V(r.fields.Ref).trim() ? "（码对不上人）" : "（无归因）"));
  const blank = cur.filter((r) => !V(r.fields.Ref).trim()).length;

  // 累计二面通过率：A02.Pass% 是现成的定案口径（Pass ÷ IV），形如 " 61%" 或 " ➖"
  const rateOf = {};
  a02.forEach((r) => { const n = PN(r.fields.Agent) || V(r.fields.Agent); if (n) rateOf[n] = V(r.fields["Pass%"]).trim() || "➖"; });

  // 累计漏斗：A02 各列求和
  const sum = (k) => a02.reduce((s, r) => s + N(r.fields[k]), 0);
  const tot = { cv: sum("CV"), iv: sum("IV"), pass: sum("Pass"), hired: sum("Hired"), active: sum("Active") };

  const L = [];
  L.push("📊 报名周报 · " + jkt(from) + " ~ " + jkt(to - DAY) + "（雅加达）");
  L.push("");
  L.push("上周新增简历 " + cur.length + " 份 " + delta(cur.length, prev.length));
  L.push("");

  L.push("【来源渠道】");
  if (byChannel.length) { const mx = byChannel[0][1];
    byChannel.slice(0, 6).forEach(([k, v]) => L.push("  " + String(v).padStart(3) + " " + bar(v, mx) + " " + k));
  } else L.push("  （无数据）");
  L.push("");

  L.push("【岗位分布】");
  if (byJob.length) L.push("  " + byJob.slice(0, 8).map(([k, v]) => k + " " + v).join(" ｜ "));
  else L.push("  （无数据）");
  L.push("");

  L.push("【经纪人表现】上周新增简历 · 累计二面通过率");
  const real = byAgent.filter(([k]) => k !== "（无归因）" && k !== "（码对不上人）");
  const orphan = (byAgent.find(([k]) => k === "（码对不上人）") || [null, 0])[1];
  if (real.length) {
    real.slice(0, 8).forEach(([k, v]) => L.push("  " + k.padEnd(10) + String(v).padStart(3) + " 份 · 通过率 " + (rateOf[k] || "➖")));
  } else L.push("  （上周没有带归因码的简历）");
  if (blank) L.push("  ⚠ 另有 " + blank + " 份没有归因码（" + pct(blank, cur.length) + "%），无法归属");
  if (orphan) L.push("  ⚠ 另有 " + orphan + " 份带码但对不上人（码已失效？）");
  L.push("");

  L.push("【累计漏斗】");
  L.push("  简历 " + tot.cv + " → 一面 " + tot.iv + " → 二面通过 " + tot.pass + " → 入职 " + tot.hired + " → 在岗 " + tot.active);
  L.push("  面试率 " + pct(tot.iv, tot.cv) + "% ｜ 二面通过率 " + pct(tot.pass, tot.iv) + "% ｜ 入职率 " + pct(tot.hired, tot.pass) + "%");
  L.push("");
  L.push("详细数据在 Lark 的 A02_任务 TASK；报名页状态看板 https://zanboooo.github.io/muke/status/");

  const text = L.join("\n");
  if (process.argv.includes("--dry")) { console.log(text); return; }
  await NOTIFY.send(text);
  // ⚠ 2026-09-06：同上 —— 公开仓库的 Actions 日志任何人可读，而周报正文含
  // 经纪人姓名与业绩排名。本机跑照打（方便看），Actions 里只打行数。
  if (process.env.GITHUB_ACTIONS) console.log("（周报已发送，正文 " + text.split("\n").length + " 行，不打进公开日志）");
  else console.log("\n" + text);
})().catch((e) => { console.error("🔴 周报生成失败：" + e.message); process.exitCode = 1; });
