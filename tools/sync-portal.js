// 经纪人门户数据层（WO-0207 建，WO-0209 改造为按人加密）
// 静态托管无后端，token 不能进前端，所以数据在构建时烘出来。
//
// ⚠ zanboooo/muke 是 **public 仓库**：藏文件名没有意义，任何人都能列目录。
//   所以「不让经纪人互相看到数据」只能靠内容加密：
//     每人一个 PIN（形如 FITRI-A7K2M9QX）→ PBKDF2-SHA256(150k) → AES-256-GCM
//   公开文件里只留「岗位」和「全局均值」，不含任何个人业绩。
//
// 产物：
//   data/jobs.json            公开：在招岗位、目标（薪资区间已于 2026-09-01 下线）
//   data/bench.json           公开：全局均值（用于「rata-rata」对比），无个人数据
//   data/j/<slug>.json        公开（候选人链接需要）：该经纪人的 姓名 + 岗位→归因码
//   data/p/<slug>.json        🔒 加密：业绩、漏斗、卡住名单、任务、下线
//   （不再产出 data/agents.json —— 它把所有人的业绩明文暴露在公网）
//
// 运行环境：GitHub Actions（每日 10:00 / 手动 / Anycross）或本机。
// 凭据全走环境变量：LARK_APP_ID LARK_APP_SECRET LARK_BASE_TOKEN
// ⚠ 公开仓库的 Actions 日志是公开的 —— 本脚本只准打印计数，不准打印姓名/电话/PIN。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { J, auth } = require("./_net.js");
const G = require("./guards.js");
const CK = require("./checks.js");
const NOTIFY = require("./notify.js");
const FORCE = process.env.FORCE_SYNC === "1";
const APP = process.env.LARK_BASE_TOKEN;
if (!APP) { console.error("🔴 缺 LARK_BASE_TOKEN"); process.exit(1); }
const OUT = path.join(__dirname, "..", "data");
const A06 = "tblesxO7u1JdTVcG";   // 背调表，仅用于预填键自检
// 2026-09-01 表重编号后的对应关系（table_id 未变，只是名字跟着挪）：
//   A02_任务 TASK（装配表，新建） / A03_经纪 AGET（原 A02） / A04_星探 SCOT（原 A03）
const T = { A01: "tblDDCntGCkEmWnK", A02: "tblIiWloAPiwkN8M", A03: "tblYMNkEDcql4pAb", A04: "tbloM0cxrKR4kOyC", A05: "tblyxgrrFk1Jzy6e",
  A08: "tblQKNfszw1LKvUJ", A09: "tbl53EDnftILW69E", H01: "tbl0IXzgKcVRJetS", H22: "tblkIVU61UVMoraT", H28: "tblBdsUE5thm5cmk" };
const V = (v) => { if (v == null) return ""; const a = (v && v.value !== undefined) ? v.value : v;
  return (Array.isArray(a) ? a : [a]).map(x => typeof x === "string" ? x : (typeof x === "number" ? String(x) : (x && (x.name || x.text || x.link)) || "")).filter(Boolean).join(","); };
const L = (v) => (v && v.link_record_ids) ? v.link_record_ids : [];
const D = (n) => { const x = parseFloat(V(n)); return x > 1e11 ? x : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// ⚠ 并发拉多表会撞 429 且被静默吞成空数组 —— 必须串行 + 重试
const pull = async (H, t) => { let r = [], pt, guard = 0;
  do { let q = null;
    for (let a = 0; a < 4; a++) {
      try { q = await J(H, "POST", `/open-apis/bitable/v1/apps/${APP}/tables/${t}/records/search?page_size=500` + (pt ? "&page_token=" + pt : ""), {}); }
      catch (e) { q = null; }
      if (q && q.data) break;
      await sleep(900 * (a + 1)); }
    if (!q || !q.data) throw new Error("拉取失败 " + t);
    r = r.concat(q.data.items || []); pt = (q.data || {}).page_token;
    await sleep(260);
  } while (pt && ++guard < 20);
  return r; };
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const slugOf = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// 人员字段取名：优先 en_name（Lark 通讯录英文名），因为 slugOf 会把中文剥成空字符串 ——
// 空 slug 让 j/<slug>.json 变成 j/.json，链接必然 404，且多个中文名互相覆盖导致归因串号。
// 2026-09-04 用「雪霞」实测暴露；她的 en_name=VILA，现有 16 人 en_name ≡ name 故零影响。
const PN = (a) => (Array.isArray(a) ? a : [a]).map((x) => (x && (x.en_name || x.name)) || "").filter(Boolean).join(",");
const hasLatin = (s) => /[a-z0-9]/.test(slugOf(s));

// ── PIN ──（去掉 I O 0 1 等易混字符）
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// 星探凭据：随机 8 位，由 Lark 自动化在建行时写入 A04.PIN，本脚本只读不写。
// 所以 GitHub 完全不需要 Lark 写权限；要作废某人，清空他那一格即可。
const ITER = 150000;
// 确定性加密：盐值由 PIN 推导、初始向量由「盐值 + 明文」推导。
// 为什么不用随机数（2026-09-04）：随机盐值让密文每轮都不同，于是 15 个面板文件
// 每次同步都算「有变化」，Actions 里「数据无变化就不提交」的保护完全失效 ——
// 改成每天多轮之后会刷出一堆纯噪音提交，真正的改动被淹没。
// 安全性不降：每人 PIN 不同 → 盐值仍各不相同，攻击者还是得对每个人单独跑
// 15 万轮 PBKDF2；IV 跟着明文走，内容一变它就变，不会出现「同一把 key 配同一个 IV
// 加密不同明文」这种 GCM 致命用法。内容没变时密文逐字节相同，正是我们要的。
const encrypt = (pin, obj) => {
  const plain = JSON.stringify(obj);
  const salt = crypto.createHash("sha256").update("muke-portal-salt-v1|" + pin).digest().slice(0, 16);
  const key = crypto.pbkdf2Sync(pin, salt, ITER, 32, "sha256");
  const iv = crypto.createHash("sha256").update(salt).update(plain, "utf8").digest().slice(0, 12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  // WebCrypto 的 AES-GCM 要求 密文||认证标签 拼在一起
  return { v: 1, it: ITER, salt: salt.toString("base64"), iv: iv.toString("base64"),
    ct: Buffer.concat([ct, c.getAuthTag()]).toString("base64") };
};

(async () => {
  const H = await auth();
  const got = {};
  const rowCount = {};
  for (const [k, v] of Object.entries(T)) { got[k] = await pull(H, v); rowCount[k] = got[k].length; console.log("  拉 " + k + " " + got[k].length + " 行"); }
  const { A01: a01, A02: a02, A03: a03, A04: a04, A08: a08, A09: a09, H01: h01, H22: h22, H28: h28 } = got;

  // ── 0. 解析 H01.Status 的「离职」选项 id（动态查元数据，选项改名/换 emoji 不断逻辑）──
  const h01f = await J(H, "GET", "/open-apis/bitable/v1/apps/" + APP + "/tables/" + T.H01 + "/fields?page_size=200");
  const stOpts = ((h01f.data.items.find(x => x.field_name === "Status") || {}).property || {}).options || [];
  // 「⛔ 离职 RES」的唯一锚 = RES 后缀（“待离职 NTC”含“离职”二字，不能按中文匹配）
  const resOpt = stOpts.find(o => /RES\s*$/.test(o.name));
  if (!resOpt) throw new Error("H01.Status 里找不到 RES 后缀的离职选项——选项被改名？停止生成以免全员被误判在职");
  const RESID = resOpt.id, RESNAME = resOpt.name;   // search 端点吐解析后的文字，GET 端点才吐 id（坑#5 补遗）

  // ── 1. 开放职位（A01 需求状态=进行中，按岗位聚合）──
  // ⚠ 2026-09-02：A01 的状态列曾叫「需求状态」，现已改名 Status。硬编码列名会在改名后静默失效
  //   （当时靠 jobs.json 体积熔断才发现），所以这里探测实际列名，两个都没有就显式报错。
  const A01ST = ["Status", "需求状态", "申请状态"].find(k => a01.some(r => k in r.fields));
  if (!A01ST) throw new Error("A01 找不到状态列（试过 Status / 需求状态 / 申请状态）——列被改名？停止生成，以免把在招岗位清空");
  console.log("  A01 状态列 = " + A01ST);
  const jobAgg = {};
  a01.forEach(r => { const f = r.fields;
    if (!/进行中/.test(V(f[A01ST]))) return;
    const cn = V(f["Job-CN"]); if (!cn) return;
    const j = jobAgg[cn] = jobAgg[cn] || { cn, id: V(f["Job-ID"]), goal: 0, urgent: false, due: null, track: V(f["Track 序列"]) };
    // due 只在生成器内部用来判 urgent，不进公开产物（前端零引用，且到岗期限属内部排期）
    j.goal += Number(V(f.Goal)) || 0;
    // ⛔ 2026-09-01 下线：薪资区间未定稿，不再输出到公开的 jobs.json。
    //    恢复时要一并改回 join/index.html 的 PAY 表与 paytag/trainpay 语言键。
    if (/紧急/.test(V(f["紧急程度"]))) j.urgent = true;
    const d = D(f["到岗期限"]); if (d && (!j.due || d < j.due)) j.due = d; });
  // 岗位是否开放，唯一判据 = A01.需求状态（jobAgg 只收「进行中」的行，所以这里全开）。
  // ⚠ 2026-08-31 修：旧版判据是 goal > onboard，而 onboard 取的是 H01 该岗位「在职总数」（存量），
  //   goal 是 A01「本批次招聘目标」—— 两个量纲不同的数在比大小，导致主播(30 vs 52)、主持、
  //   舞导、财务、拍摄剪辑五个岗位被错误隐藏。根因是 A01「已入职人数/到岗人数」两根公式引用了
  //   已删除的 A05 列（fldGcG7U79 / fldX40WHIS），值恒空，生成器只好拿存量顶替。
  //   A01 统计修好前，这里不做任何减法。招满即停未来由 A01.需求状态 的自动化控制，与本文件解耦。
  // 在职判据＝白名单，只认试用与转正 —— 与 A02/A03 的 Active 列同口径（Trial + Conf）。
  // ⚠ 2026-09-04 修：旧判据是黑名单（只排除「离职」），把 23 个状态空白 + 9 个「未到 NHR」
  //   也算成了员工，对外显示 97 人而真实在职 65，虚高 49%。同一个 staffBy 还喂给每个岗位卡片。
  const ACTIVE = /试用|TRI|转正|CFM/;
  const staffBy = {}; let staffTotal = 0;
  h01.forEach(r => { if (!ACTIVE.test(V(r.fields.Status))) return; staffTotal++;
    const c = V(r.fields["Job-CN"]); if (c) staffBy[c] = (staffBy[c] || 0) + 1; });
  // 岗位主题色：H22.Job-CN 的选项 color 只作「色系分组」用，不复制色值 —— 每组给一个为网站配色挑的色相
  // （张博 2026-08-31：主题色仅接近色相即可，以网站美观为主）
  const HUE = { 6: 335, 7: 32, 3: 272, 9: 168, 2: 205, 8: 200, 5: 190 };
  const h22f = await J(H, "GET", "/open-apis/bitable/v1/apps/" + APP + "/tables/" + T.H22 + "/fields?page_size=200");
  const jobOpts = ((h22f.data.items.find(x => x.field_name === "Job-CN") || {}).property || {}).options || [];
  const colorOf = {}; jobOpts.forEach(o => colorOf[o.name] = o.color);

  // 报名渠道选项：从 A05.Kanal 实时读，不写死在页面里。
  // 页面靠 UA 认出「TikTok」这类关键词后，在这份列表里模糊找对应项 ——
  // 这样张博在 UI 改 emoji、改措辞、加新渠道，次日同步后自动适配，不用改代码。
  // （prefill 对单选是严格精确匹配，差一个空格就静默失败，所以值必须来自线上而非手抄。）
  const a05f = await J(H, "GET", "/open-apis/bitable/v1/apps/" + APP + "/tables/" + T.A05 + "/fields?page_size=200");
  const kanalOpts = (((a05f.data.items || []).find(x => x.field_name === "Kanal") || {}).property || {}).options || [];
  const srcOpts = kanalOpts.map(o => o.name);
  const jdBy = {};
  // JD 双语：H22 两列现成的。候选人是印尼人，页面按语言切；缺印尼文时回落中文。
  const jdIdBy = {};
  const jidBy = {};   // 岗位代码 P111 —— 落地页要把它预填进表单的 JOB 题
  h22.forEach(r => { const cn = V(r.fields["Job-CN"]); if (!cn) return;
    jdBy[cn] = V(r.fields["JD 岗位说明"]);
    jdIdBy[cn] = V(r.fields["JD Uraian Tugas"]);
    jidBy[cn] = V(r.fields.JID); });
  // staff（该岗位真实在岗人数）2026-09-05 起不再输出 —— 张博定案不对外。
  // 卡片上原先用它显示「团队 N 人」并按它画头像个数，现已换成手动的职级标签 + 固定装饰数。
  // goal（招 N 人）保持实时同步：它反映的是招聘需求，不是编制。
  // 真实在岗人数仍进加密的 _status.json（activeStaff），PIN 进 /status/ 才看得到。
  const jobs = Object.values(jobAgg).map(({ due, ...j }) => ({ ...j, open: true,
    hue: HUE[colorOf[j.cn]] != null ? HUE[colorOf[j.cn]] : 300,
    jd: jdBy[j.cn] || "", jdId: jdIdBy[j.cn] || jdBy[j.cn] || "", jid: jidBy[j.cn] || "" }));
  const openCn = {}; jobs.forEach(j => { openCn[j.cn] = 1; });

  // ── 2. 表单链接（H28 通用简历）──
  const cvForm = h28.find(r => /通用简历|简历/.test(V(r.fields.LinkType) + V(r.fields["描述"])));
  const CVURL = cvForm ? V(cvForm.fields["原始链接"]) : "";
  // 每岗位的「问卷(背调)/笔试」表单地址 —— H28 是唯一注册表：加岗位只需在 H28 贴一行 URL，
  // 前端零改动。三步流程用它，不再依赖表单之间的 UI 静态跳转（那条链带不了归因码）。
  const links = {};
  h28.forEach(r => { const lt = V(r.fields.LinkType), cn = V(r.fields["Job-CN"]), u = V(r.fields["原始链接"]);
    if (!cn || !u) return;
    links[cn] = links[cn] || {};
    if (/背景调查/.test(lt)) links[cn].bg = u;
    if (/招聘笔试/.test(lt)) links[cn].ex = u; });

  // ── 3. 漏斗指标（按归因码）──
  // 阶段存「代码」不存文案，前端按语言渲染；by = 卡在谁手里
  const a08byEval = {}; a08.forEach(r => L(r.fields.EVAL).forEach(id => a08byEval[id] = r));
  const h01byEval = {}; h01.forEach(r => L(r.fields.EVAL).forEach(id => h01byEval[id] = r));
  const S = {};
  const bump = (ref) => S[ref] = S[ref] || { cv: 0, iv: 0, iv1: 0, pass: 0, hired: 0, days: [], stuck: [] };
  a09.forEach(r => {
    const ref = V(r.fields["归A码"]) || V(r.fields.Ref); if (!ref) return;   // WO-0255：必须归A码优先——原始 Ref 是旧码/星探码，与 A03.ARef 对不上会让面板全 0
    const b = bump(ref); b.cv++;
    const created = D(r.fields.Created);
    const iv = a08byEval[r.record_id], emp = h01byEval[r.record_id];
    let stage = "masuk", since = created;
    if (iv) { b.iv++; stage = "wait_iv"; since = D(iv.fields.Created) || since;
      if (D(iv.fields["IV1Pass Time"])) { b.iv1++; stage = "pass1"; since = D(iv.fields["IV1Pass Time"]); }
      // 二面通过口径与 A03.Passed 保持一致：IV2Pass Time 非空
      // （原先读 A08.Result —— 该列已改名为「Result待删除」，读不到就静默恒 0）
      if (D(iv.fields["IV2Pass Time"])) { b.pass++; stage = "wait_join"; }
      if (/未过|淘汰/.test(V(iv.fields["Result待删除"]))) stage = "reject"; }   // ⚠ 删该列前必须先改这里
    if (emp) { b.hired++; stage = "hired";
      const s = D(emp.fields.Start);
      if (s && created && s >= created) b.days.push(Math.round((s - created) / 864e5)); }
    if (!/hired|reject/.test(stage) && since) {
      const d = Math.round((Date.now() - since) / 864e5);
      if (d >= 3) b.stuck.push({ name: V(r.fields.Name).slice(0, 18), stage, days: d,
        by: /wait_iv|wait_join/.test(stage) ? "hr" : "agent" }); }
  });
  Object.values(S).forEach(b => { b.stuck.sort((x, y) => y.days - x.days); b.stuck = b.stuck.slice(0, 8);
    b.speed = med(b.days); delete b.days; });

  // ── 4. 经纪人任务（A03_经纪 AGET）──
  // 离职交接（2026-08-31 张博定）：离职经纪人的 A03 行归档不删、码永远有效；
  // 其人级链接 /join/?a=<名> 不关闭，改为自动转产 —— j/<slug>.json 写 movedTo=HR，
  // byJob 换成 HR 的码，新候选人从进门第一秒就归 HR，无需事后换码。
  // 离职移交（2026-09-05 张博定案，取代原「转产给 HR」）：
  //   经纪人离职 → A03.Emp Status（lookup H01.Status）出现「离职」→ 页面**不下线**，
  //   码直接归公司 MX5J。不再移交给任何个人，因此不存在「接手人也离职」的连环问题。
  //   MX5J 是张博在 A03 的码，11 个岗位全覆盖；他不招人不拿佣金，历史上的离职移交也都在这里。
  const COMPANY = "MX5J";     // 公司直招码 = 一切无主归因的落点
  const HANDOFF = "MUKE";     // 页面上展示给候选人的接手方名字（不是归因码）
  const tasksAll = a03.map(r => { const f = r.fields;
    const ref = V(f.ARef); if (!ref) return null;
    const s = S[ref] || { cv: 0, iv: 0, iv1: 0, pass: 0, hired: 0, speed: null, stuck: [] };
    return { ref, atid: V(f.ATID), name: PN(f.Agent), job: V(f["Job-CN"]), jobId: V(f.Posisi),
      goal: Number(V(f.Goal)) || 0,
      // 岗位级数字直接读 A03 的双条件计数列——生成器自己按码分桶只到人一级，切不出岗位
      cv: Number(V(f.CV)) || 0, hired: Number(V(f.Hired)) || 0,
      // 离职判据 = Emp Status（lookup H01.Status，WO-0229 起唯一源头；手工「状态」列已删）。
      // lookup 套 select 经 API 读出是选项 id（坑#5），RESID 在下方从 H01 字段元数据动态解析。
      off: V(f["Emp Status"]) === RESNAME || V(f["Emp Status"]) === RESID,
      open: f.Open === true,     // A03.Open 复选（WO-0228）：勾上才对外展示；码本身始终有效
      stats: s }; }).filter(Boolean);
  const tasks = tasksAll.filter(t => !t.off);
  const gone  = tasksAll.filter(t => t.off);
  const subs = {};
  a04.forEach(r => { const up = V(r.fields.ARef); if (!up) return;
    (subs[up] = subs[up] || []).push({ sref: V(r.fields.SRef), name: V(r.fields.Referrer) || V(r.fields.Agent),
      job: V(r.fields["Job-CN"]), cv: Number(V(r.fields.CV)) || 0 }); });

  // ── 5. 全局基准（公开，不含个人数据）──
  // ⚠ 2026-09-04 WO-A94：口径必须与个人数字同源。
  //    面板上的个人数字直接读 Lark 的 A03/A04 列（判据 Punch>0 且 Type 含"正式"），
  //    bench 原先在本段用 JS 另算一套（只要 H01 有行就算入职），两者做 cmp() 是苹果比橘子：
  //    实测 Hired 74(Lark) vs 120(JS)、IV 209 vs 230。
  //    比率公式也不同 —— A03.Hire% = Hired÷Pass，而这里原先写的是 Hired÷CV。
  //    现改为汇总 A03 的列（A03 已含星探 rollup，每条 A09 只被计一次，实测 CV 两边同为 239）。
  //    speed 例外：Lark 无对应列（Lead Time 已删），仍按 H01.Start − A09.Created 取中位数。
  const NUM = (v) => Number(String(V(v)).replace(/[^0-9.-]/g, "")) || 0;
  const colSum = (k) => a03.reduce((acc, r) => acc + NUM(r.fields[k]), 0);
  const R = (a, b) => b ? Math.round(a / b * 100) : 0;
  const tot = { cv: colSum("CV"), iv: colSum("IV"), pass: colSum("Pass"), hired: colSum("Hired"),
    iv1: Object.values(S).reduce((acc, b) => acc + b.iv1, 0) };   // iv1 无 Lark 对应列，保留本地口径
  const speeds = Object.values(S).map(b => b.speed).filter(x => x != null);
  const bench = { ...tot, speed: med(speeds),
    ivRate:   R(tot.iv, tot.cv),        // 面试率    = IV ÷ CV
    passRate: R(tot.pass, tot.iv),      // 二面通过率 = Pass ÷ IV   ← 与 A03.Pass% 同式
    hireRate: R(tot.hired, tot.pass) }; // 入职率    = Hired ÷ Pass ← 与 A03.Hire% 同式（不是 ÷CV）

  // ── 6. 按人归并（81 个码只对应 14 个人）──
  const byPerson = {};
  const noLatin = new Set();
  tasks.forEach(t => { if (!t.name) return;
    // 名字里没有拉丁字符（en_name 也是中文/空）→ 退回归因码做 slug，绝不产出空名文件。
    // 归因码全局唯一，链接照样可用；同步日志会点名提示去通讯录补英文名。
    const k = hasLatin(t.name) ? slugOf(t.name) : slugOf(t.ref);
    if (!hasLatin(t.name)) noLatin.add(t.ref);
    if (!k) return;
    (byPerson[k] = byPerson[k] || { slug: k, name: t.name, rows: [] }).rows.push(t); });
  if (noLatin.size) console.log("  ⚠ " + noLatin.size + " 位经纪人无拉丁名，链接已退回归因码（请在 Lark 通讯录补英文名）");

  // ── 7. 凭据 ──
  // WO-0255 定案后经纪人不再有网页面板，A02 的 PIN 已作废；
  // 星探凭据在 8a 段直接从 A04.PIN 逐行读取，这里不再需要任何 PIN 表。

  // ── 8. 写盘 ──
  // 只到「天」：两个前端都是 String(stamp).slice(0,10) 当日期显示，秒级精度没人看。
  // 而带秒的时间戳会让 jobs/bench/每份面板的明文每轮都变 → 密文跟着变 →
  // Actions 的「数据无变化就不提交」永远命中不了，每轮都刷一个噪音提交（2026-09-04）。
  const stamp = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);   // 雅加达日期
  // 护栏④：先算出这次会写多少个 j/，与上次比对后才动手
  const nextEntry = Object.keys(byPerson).length + new Set(gone.filter(t => t.name).map(t => slugOf(t.name))).size;
  const entryVol = FORCE ? "（已跳过）" : G.guardEntryCount(OUT + "/j", nextEntry);
  fs.mkdirSync(OUT + "/j", { recursive: true });
  fs.mkdirSync(OUT + "/p", { recursive: true });
  fs.mkdirSync(OUT + "/s", { recursive: true });
  // 断链检测（第 ⑤ 道）的基线：动手写之前先记下现在有哪些入口文件。
  const listEntry = (d) => { try { return fs.readdirSync(OUT + "/" + d).filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")); } catch (e) { return []; } };
  const beforeJ = listEntry("j"), beforeS = listEntry("s");
  // 旧的明文全量文件必须删掉
  const legacy = OUT + "/agents.json";
  if (fs.existsSync(legacy)) { fs.unlinkSync(legacy); console.log("  🗑 已删除 data/agents.json（明文暴露全员业绩）"); }

  // ⚠ 顶层 staff（在职总人数）2026-09-05 起不再输出 —— 张博定案：这是隐私数据。
  // 页面上那个数字改由 data/manual.json 手动给固定值（"65+"），不跟真实数字走。
  // 真实值仍写进加密的 _status.json，PIN 进 /status/ 才看得到。
  const jobsObj = { stamp, cvForm: CVURL, links, srcOpts, jobs };
  // ⚠ 公开文件按「前端真正读到的字段」输出，不多给一个字（2026-09-04 收窄）。
  // 原来整个 bench 都往外倒：cv 243 / iv 213 / pass 130 / hired 74 与三个转化率 ——
  // 那是公司完整的招聘漏斗，等于把招聘规模和效率摆给任何人看，而前端**只用了 speed**
  // （页面上「N 天入职」那个数）。其余八个字段一次都没被引用过。
  // 只放比率，不放绝对数 —— 「简历243/入职74」那种完整漏斗仍然不上公网，
  // 但 speed / passRate / hireRate 是三个页面真正读到的：
  //   join  读 speed（「N 天入职」）
  //   agent 读 passRate + hireRate（星探两个主 KPI 的「平均」对比）
  // ⚠ 2026-09-04 曾砍到只剩 speed，星探面板的对比栏当场全变「平均 —」；
  //   不报错、不崩溃，所以没人发现。下面第 ④ 道巡检就是为防这种事加的。
  const benchObj = { stamp, bench: {
    // speed 同样不再出公网：join 的「入职周期」改用 manual.json 的固定值。
    // 星探面板只比 passRate / hireRate（agent 页的 k_speed 只是个从未被渲染的标签），
    // 所以砍掉 speed 不会重演 2026-09-04 那次「对比栏全变平均 —」的静默故障。
    passRate: bench.passRate, hireRate: bench.hireRate } };
  G.guardPublic("jobs.json", jobsObj);           // 护栏①
  G.guardPublic("bench.json", benchObj);
  const jobDiff = G.diffJobs(OUT + "/jobs.json", jobsObj);
  const vol = FORCE ? "（已跳过）" : G.guardVolume("jobs.json", jobsObj, OUT + "/jobs.json");  // 护栏②
  fs.writeFileSync(OUT + "/jobs.json", JSON.stringify(jobsObj, null, 1));
  fs.writeFileSync(OUT + "/bench.json", JSON.stringify(benchObj, null, 1));

  Object.values(byPerson).forEach(p => {
    // 候选人链接要的：姓名 + 岗位→码（无任何业绩数字）
    const byJob = {};
    p.rows.forEach(t => { if (t.open && t.job && !byJob[t.job]) byJob[t.job] = t.ref; });
    // 只输出前端真读的两个字段。原先还带一个 ref（此人的 ARef）——前端从不读它，
    // 而 data/ 全目录公开可下载，多一个字段就是多泄露一项。归因码本来就在 byJob 的值里，
    // 顶层再放一份纯属冗余。（2026-09-05 收窄暴露面）
    const jObj = { name: p.name, byJob };
    G.guardPublic("j/" + p.slug + ".json", jObj);
    fs.writeFileSync(OUT + "/j/" + p.slug + ".json", JSON.stringify(jObj, null, 1));
    p.byJob = byJob;

    // ⚠ WO-0255 定案：经纪人不再有网页面板。
    //    理由：静态托管的加密文件谁都能下载 → 离线爆破无速率限制，只能靠密钥强度扛。
    //    而经纪人本来就有 Lark 账号，配记录级权限在 Lark 里看自己的数据即可——
    //    有真实身份验证、可撤销、有审计。网页面板只留给没有 Lark 的星探，
    //    且只放汇总数字、不放候选人姓名，这样公开文件里就没有值得爆破的东西。
  });

  // ── 8a. 星探面板（WO-0255）──
  // 只有星探需要网页面板：他们没有 Lark 账号，看不到 Base。
  // ⛔ 内容只放本人汇总数字——不放候选人姓名、不放他人数据。
  //    公开托管的加密文件挡不住离线爆破，唯一稳妥的做法是让里面没有值得爆破的东西。
  let scoutOut = 0, scoutNoPin = 0, scoutSample = null;
  const scoutCodes = [];
  a04.forEach(r => {
    const f = r.fields;
    const code = V(f.SRef).trim(); if (!code) return;
    const pin = V(f.PIN).trim();
    if (!pin) { scoutNoPin++; return; }
    const num = k => Number(V(f[k])) || 0;
    const payload = { stamp, role: "scout",
      name: V(f.Scot), code,
      up: V(f.Agent),                       // 上线经纪人，星探要知道自己归谁
      channel: V(f.Channel),
      // ⚠ 2026-09-04 列名与口径已变（A03/A04 统一命名，见 SOP-OS-007）：
      //   Passed→Pass ｜ Conv %→Hire% ｜ Pass Rate→Pass% ｜ 7 Hari→CV7d ｜ Lead Time 已删
      //   语义也变了：Trial 现指「试用期中」（原为累计入职），Hired 现指「累计入职」（原为当前在职）
      //   新增 Active＝在岗（佣金口径）、Conf＝已转正
      //   agg.pass 的 key 要与前端 s.pass 对齐，不能写成 passed
      agg: { cv: num("CV"), pr: num("PR"), ex: num("EX"), iv: num("IV"),
             pass: num("Pass"), hired: num("Hired"),
             trial: num("Trial"), conf: num("Conf"), active: num("Active") },
      conv: V(f["Hire%"]), passRate: V(f["Pass%"]),
      week: V(f["CV7d"]), iv7d: V(f["IV7d"]), funnel: V(f.Funnel),
      // 抬头要显示"这是哪个岗位的码" —— 同一个人可能有 4 个码，不标岗位在页面上完全一样
      job: V(f["Job-CN"]), jobId: V(f["Job-ID"]), status: V(f["SC Status"]),
      // ⚠ 邀请链接只认 A04.Invite URL，空就空着 —— 前端整块隐藏。
      //    绝不能由前端拼 join/?a=<姓名>：星探没有 data/j/<姓名>.json，那样必定 404 报错；
      //    且现网 10 行备注写明「临时介绍人·无需专属邀请链接」，他们本就走 HR 线下登记。
      url: V(f["Invite URL"]).trim() };
    fs.writeFileSync(OUT + "/p/" + code.toLowerCase() + ".json",
      JSON.stringify(encrypt(pin, payload)));
    scoutCodes.push(code.toLowerCase());
    if (!scoutSample) scoutSample = payload;   // 供第 ④ 道字段契约巡检（落盘的是密文）
    scoutOut++;
  });
  console.log("  🔒 星探面板 " + scoutOut + " 份" + (scoutNoPin ? "（" + scoutNoPin + " 人无 PIN，已跳过）" : ""));

  // ── 8d. 星探码索引 data/s/<码>.json（2026-09-05 WO-A99）──
  // ?r=<SRef> 要能查出「这是谁、挂的哪个岗位」。公开可读，因此**只放姓名和岗位，绝无业绩数字**
  //（同 j/*.json 的口径：候选人链接必须匿名可解析）。
  // 星探一行 = 一个码 = 一个岗位，所以这个索引天然是「一码一岗」，与经纪人的多岗位 j/ 不同。
  fs.mkdirSync(OUT + "/s", { recursive: true });
  let sOut = 0;
  a04.forEach(r => {
    const f = r.fields;
    const code = V(f.SRef).trim(); if (!code) return;
    const sObj = { name: V(f.Scot), job: V(f["Job-CN"]), ref: code };
    G.guardPublic("s/" + code.toLowerCase() + ".json", sObj);
    fs.writeFileSync(OUT + "/s/" + code.toLowerCase() + ".json", JSON.stringify(sObj, null, 1));
    sOut++;
  });
  console.log("  🔗 星探码索引 s/ " + sOut + " 个（?r=<码> 用，只含姓名+岗位）");

  // ── 8b. 离职经纪人：页面不下线，码归公司 ──
  // 老链接永远有效，候选人照常看到当前全部在招岗位，只是归因落到 COMPANY。
  const companyByJob = {};
  jobs.forEach(j => { if (j.cn) companyByJob[j.cn] = COMPANY; });   // 公司码覆盖全部在招岗位
  const goneBy = {};
  gone.forEach(t => { if (t.name) (goneBy[slugOf(t.name)] = goneBy[slugOf(t.name)] || t.name); });
  Object.entries(goneBy).forEach(([slug, name]) => {
    fs.writeFileSync(OUT + "/j/" + slug + ".json",
      JSON.stringify({ name, movedTo: HANDOFF, byJob: companyByJob }, null, 1));
    // 离职者不再有面板：清掉加密业绩文件（PIN 也随之作废）
    const pf = OUT + "/p/" + slug + ".json";
    if (fs.existsSync(pf)) { fs.unlinkSync(pf); console.log("  🗑 已删离职面板 p/" + slug + ".json"); }
  });
  if (Object.keys(goneBy).length)
    console.log("  🏢 离职链接归公司（" + COMPANY + "）：" + Object.values(goneBy).join("、"));

  // ── 8c. 清理孤儿文件（WO-0276）──
  // 生成器本来只写不删，所以一旦 A02/A04 删了行，对应的 j/ 或 p/ 文件会永远留着 ——
  // 更糟的是那条老链接依然打得开，把候选人归因到一个已不存在的码上。
  // 判据是「A02/A04 里还有没有这一行」，不是「是否离职」：
  //   · 离职但行还在 → goneBy 里有，属转产文件，必须保留（老链接永不失效是刻意设计）
  //   · 行被删掉     → 谁都不认得它了，删
  // 熔断：一次要删超过 3 个就只报不删 —— 那多半是数据源出问题，不是真有人被删。
  const keepJ = new Set([...Object.keys(byPerson), ...Object.keys(goneBy)]);
  const keepP = new Set(scoutCodes);
  const sweep = (dir, keep, label) => {
    let files = [];
    try { files = fs.readdirSync(OUT + "/" + dir).filter((f) => f.endsWith(".json")); } catch (e) { return []; }
    const orphan = files.map((f) => f.replace(/.json$/, "")).filter((k) => !keep.has(k));
    if (!orphan.length) return [];
    if (orphan.length > 3) {
      console.log("  ⚠ " + label + " 有 " + orphan.length + " 个孤儿（超过 3 个，疑似数据源异常，本次不删）：" + orphan.join("、"));
      return orphan;
    }
    orphan.forEach((k) => { fs.unlinkSync(OUT + "/" + dir + "/" + k + ".json");
      console.log("  🗑 已删孤儿 " + dir + "/" + k + ".json（对应记录已不存在）"); });
    return [];
  };
  const orphanJ = sweep("j", keepJ, "入口文件 j/");
  const orphanP = sweep("p", keepP, "星探面板 p/");
  const orphanS = sweep("s", keepP, "星探码索引 s/");   // 与 p/ 同一份 keep：都以 A04 的码为准

  console.log("\n✅ 数据层已生成（按人加密）");
  console.log("  开放职位 " + jobs.length + " 个：" + jobs.map(j => j.cn + "×" + j.goal).join("  "));
  console.log("  简历表单 " + (CVURL ? "✅ " + CVURL.slice(0, 60) : "🔴 未找到"));
  console.log("  公开文件：jobs.json、bench.json、j/*.json（仅姓名+码，无业绩）");
  console.log("  🔒 星探面板 p/*.json（PBKDF2 " + ITER + " 轮 + AES-256-GCM）；经纪人改在 Lark 看，无网页面板");
  console.log("  全局基准：简历" + bench.cv + " → 面试率" + bench.ivRate + "% → 二面通过率" + bench.passRate + "% → 入职率" + bench.hireRate + "% → 中位入职 " + bench.speed + " 天");

  // 护栏③：把这次改了什么写进 Actions Summary。
  // 前两道护栏是「拦」，这道是「留痕」—— 出事能倒查是哪次同步、改了哪些岗位。
  const jkt = new Date(Date.now() + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
  const sm = G.summary([
    "## 报名页同步 · " + jkt + "（雅加达）", "",
    "| 项 | 值 |", "|---|---|",
    "| 开放职位 | " + jobs.length + " 个 |",
    "| 经纪人 | " + Object.keys(byPerson).length + " 人 / " + tasks.length + " 个任务码 |",
    "| jobs.json 体积 | " + vol + " |",
    "| 入口文件 j/ | " + entryVol + " |",
    "| 渠道选项 | " + srcOpts.length + " 项 |",
    "", "### 岗位变化", ...jobDiff.map(x => "- " + x),
  ]);
  if (!process.env.GITHUB_STEP_SUMMARY) { console.log(""); console.log(sm); }   // 本机跑时也看得见

  // ── 10. 五道巡检（WO-0274 建三道，WO-A97 补第四，2026-09-06 删库重建后补第五道）：查结果而非查过程，详见 checks.js 顶部 ──
  const formList = h28
    .map((r) => ({ label: V(r.fields.LinkType) + (V(r.fields["Job-CN"]) ? "·" + V(r.fields["Job-CN"]) : ""), url: V(r.fields["原始链接"]) }))
    .filter((x) => x.url && x.url.indexOf("share/base/form") >= 0);
  const checks = [];
  checks.push(CK.attribution(got.A05 || [], V, { days: 7, minCount: 5, minRatio: 0.3 }));
  checks.push(await CK.prefillKeys(J, H, APP, [
    ["简历表单", T.A05, ["Ref", "Full Name", "WhatsApp", "JOB", "Kanal"]],
    ["背调表单", A06, ["Ref", "Full Name", "WhatsApp"]],
  ]));
  checks.push(await CK.formLinks(formList));
  // 第 ④ 道：回读刚写下的产物，核对前端要用的字段是否真的在里面。
  // 刻意回读磁盘而不是用内存对象 —— 要验的是「最终落盘的东西」，中间任何一层收窄都能被抓到。
  const back = (rel) => { try { return JSON.parse(fs.readFileSync(OUT + "/" + rel, "utf8")); } catch (e) { return undefined; } };
  // 整份目录都要查，不是抽一个 —— j/ 的在职与离职是两条不同的写入分支，抽样必有盲区。
  const allIn = (dir) => { try { const o = {};
    fs.readdirSync(OUT + "/" + dir).filter((x) => x.endsWith(".json"))
      .forEach((f) => { const v = back(dir + "/" + f); if (v) o[f] = v; });
    return Object.keys(o).length ? { __all: o } : undefined; } catch (e) { return undefined; } };
  const anyJ = allIn("j");
  const anyS = allIn("s");
  const benchBack = back("bench.json");
  checks.push(CK.linksLost({ j: { before: beforeJ, after: listEntry("j") },
                             s: { before: beforeS, after: listEntry("s") } }));
  // 第 ⑤ 道：查「已发布却没上站」。用的是刚回读的 anyJ，跟第 ④ 道同一份磁盘快照 ——
  //   要验的是最终落盘的产物，不是内存里的意图。
  checks.push(CK.publishedNotLive(a02, anyJ, V));
  checks.push(CK.dataContract({
    "bench.json": benchBack && benchBack.bench,      // 前端读的是 d.bench 这一层
    "jobs.json": back("jobs.json"),
    "j/<任一>.json": anyJ,
    "s/<任一>.json": anyS,
    "jobs.json[jobs[0]]": ((back("jobs.json") || {}).jobs || [])[0],
    // manual.json 不由本脚本生成（手动维护），但字段齐不齐照样要核 ——
    // 少一个键，报名页那个数字就变横杠，而且是静默的。
    "manual.json": back("manual.json"),
    "p/<任一>.json": scoutSample,                     // 密文核对不了，用内存里的明文
  }));
  checks.forEach((c) => console.log("  " + (c.ok ? "✅" : "⚠️") + " " + c.name + "：" + c.msg));
  const alert = CK.compose(checks, jkt);
  if (alert) await NOTIFY.send(alert);

  // ── 11. 状态文件：给 /status/ 看板用 ──
  // ⚠ 这个文件和 data/ 下其他文件一样是公开可读的（彩蛋入口只是「不显眼」，不是「保密」）。
  //    所以这里只放运营指标与护栏结果，绝不放 table_id、凭据、人名、电话。
  const statusObj = {
    stamp,
    syncedAt: jkt + " (WIB)",
    rows: rowCount,                               // 各表拉了多少行
    guards: {
      sensitive: "pass",                          // 护栏①：跑到这里说明没拦下
      jobsVolume: vol,                            // 护栏②：产物体积变化
      entryFiles: entryVol,                       // 护栏④：入口文件数
      forced: FORCE,                              // 是否跳过了护栏
    },
    live: {
      activeStaff: staffTotal,                    // 在职＝试用+转正（白名单口径）
      openJobs: jobs.length,
      agents: Object.keys(byPerson).length,
      taskCodes: tasks.length,
      entryFiles: nextEntry,
      scoutPanels: scoutOut,
      scoutNoPin: scoutNoPin,
      channels: srcOpts.length,
    },
    bench: { cv: bench.cv, ivRate: bench.ivRate, passRate: bench.passRate, hireRate: bench.hireRate, days: bench.speed },
    config: {
      schedule: "10:00–17:00 WIB 每整点",
      pbkdf2Iter: ITER,
      volumeCap: "30%",
      entryTolerance: 3,
      handoff: HANDOFF,                           // 离职链接的接手人
      cvForm: CVURL ? "ok" : "missing",
    },
    orphans: { j: orphanJ, p: orphanP },
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, msg: c.msg })),
    jobDiff,
  };
  // ⚠ 状态文件含各表行数、在职人数、招聘目标 —— 是经营数据，而 data/ 全目录公开可读，
  // 「入口做成彩蛋」只是不显眼、不等于锁上。配了 STATUS_PIN 就加密（与星探面板同一套：
  // PBKDF2-150k + AES-256-GCM），没配则退回明文并显式警告，绝不静默把数据摊在外面。
  // ── 只在**实质内容**变化时才重写（2026-09-05 加）──
  // 加密本身是确定性的（salt/iv 都由内容派生，同样明文出同样密文），本来同内容不会产生 diff。
  // 但 statusObj 里带 syncedAt（精确到分钟），于是每跑一次密文就不一样 →
  // git diff 永远非空 → 每次都提交、每次都部署。cron 从 2 次加密到 8 次后这个代价被放大：
  // 明明什么都没变，也会推 8 次、让 Pages 重新部署 8 次，白白扩大「切换瞬间新开页面」的窗口。
  //
  // 解法：把「除 syncedAt 之外的全部内容」的哈希写进密文**外层**的 sig 字段。
  // sig 相同就整个跳过写入，文件一个字节都不动，git 自然没有 diff。
  // stamp（雅加达日期）**故意留在 sig 里** —— 这样即使业务毫无变化，每天也会重写一次，
  // 作为「同步还活着」的心跳；否则「没变化」和「同步挂了」在产物上长得一模一样。
  const sigOf = (o) => {
    const rest = {}; for (const k of Object.keys(o)) if (k !== "syncedAt") rest[k] = o[k];
    return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
  };
  const newSig = sigOf(statusObj);
  let oldSig = null;
  try { oldSig = (JSON.parse(fs.readFileSync(OUT + "/_status.json", "utf8")) || {}).sig || null; } catch (e) { }

  const SPIN = (process.env.STATUS_PIN || "").trim();
  if (SPIN && oldSig === newSig) {
    console.log("  ⏭ 状态文件内容未变（sig " + newSig + "），跳过写入 —— 本次不产生 diff、不部署");
  } else if (SPIN) {
    fs.writeFileSync(OUT + "/_status.json",
      JSON.stringify(Object.assign({ sig: newSig }, encrypt(SPIN, statusObj))));
    console.log("  🔒 状态文件已加密并更新（sig " + (oldSig || "无") + " → " + newSig + "）");
  } else {
    // ⚠ 没配 PIN 时**绝不覆盖已有的密文** —— 2026-09-05 的教训：
    //    本机跑同步没有 STATUS_PIN（它只在 GitHub Secrets 里），于是每次都把线上那份
    //    加密的 _status.json 覆盖成明文，还跟着提交推了上去。代码本来有显式警告，
    //    但它淹没在几十行输出里，连着几轮没被看见。防呆比警告可靠。
    let existingEnc = false;
    try { const cur = JSON.parse(fs.readFileSync(OUT + "/_status.json", "utf8"));
      existingEnc = !!(cur && cur.ct && cur.salt && cur.iv); } catch (e) { }
    if (existingEnc) {
      console.log("  🛡 未配 STATUS_PIN，但线上那份是密文 —— 保持不动，不降级为明文");
    } else {
      fs.writeFileSync(OUT + "/_status.json", JSON.stringify(statusObj, null, 1));
      console.log("  ⚠ 状态文件为明文 —— 未配 STATUS_PIN，各表行数等经营数据公开可读");
    }
  }
})();
