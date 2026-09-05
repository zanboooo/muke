// 报名链路的五道巡检（WO-0274 建三道，WO-A97 补第四道，WO-A100 补第五道）。由 sync-portal.js 在同步末尾调用。
//
// 设计取舍：候选人侧的失败全都发生在他们自己的浏览器里，我们收不到任何信号。
// 与其让前端上报（静态站没后端，要么新开端点要么把令牌放进公开代码），
// 不如**在数据侧查结果** —— 不管是入口文件挂了、表单题目名被改了、还是经纪人发错链接，
// 最终都表现为「新简历没有归因码」，一个判据全网打尽。
//
// 三道检查都不中止同步：数据该更新还是要更新，问题另行告警。
// 唯一例外见 keys 检查的说明。
const https = require("https");

// ── ① 归因健康度：最近 N 天新增简历里有多少条没有有效归因码 ──
// 成因不重要（入口 404 / 题目名被改 / 手工录入），重要的是它突然变多 —— 链路某处断了。
//
// ⚠ 2026-09-05（WO-A98）起判据不再只看「空」：
//   公开入口的自然流量现在会带默认码 MUKE，失效链接降级来的带 MUKEX（见 join 的 refFor）。
//   MUKE 是预期存在的，不计入；MUKEX 本身就是「有链接失效了」的信号，必须计入 ——
//   否则填了默认码之后空 Ref 归零，这道巡检就再也发现不了链接批量失效。
function attribution(a05, V, opts) {
  const days = (opts && opts.days) || 7;
  const minCount = (opts && opts.minCount) || 5;
  const minRatio = (opts && opts.minRatio) || 0.3;
  const since = Date.now() - days * 86400e3;
  const recent = a05.filter((r) => {
    const t = Number(V(r.fields["Created_Time"])) || 0;
    return t > 1e11 && t >= since;
  });
  const LOST = new Set(["", "MUKEX"]);   // 空 = 表单被直接打开/手工录入；MUKEX = 失效链接降级
  const blank = recent.filter((r) => LOST.has(String(V(r.fields["Ref"]) || "").trim().toUpperCase()));
  const ratio = recent.length ? blank.length / recent.length : 0;
  const bad = blank.length >= minCount && ratio >= minRatio;
  return {
    name: "归因健康度",
    days, total: recent.length, blank: blank.length, ratio: Math.round(ratio * 100),
    ok: !bad,
    msg: recent.length === 0
      ? "近 " + days + " 天没有新简历，无法判断"
      : "近 " + days + " 天新简历 " + recent.length + " 份，其中 " + blank.length + " 份没有有效归因码（空或 MUKEX，" + Math.round(ratio * 100) + "%）",
  };
}

// ── ② 预填键自检：表单预填认的是「题目标题」，题目一改名预填就静默失效 ──
// 这里退一步查字段是否还在：题目默认跟字段同名，字段没了题目必然也没了。
// 不中止同步 —— 同步与表单是两条独立的路，停掉同步只会让网站数据变陈旧，
// 并不能修复表单，反而多制造一个问题。
async function prefillKeys(J, H, APP, spec) {
  const miss = [];
  for (const [label, tbl, keys] of spec) {
    let names = null;
    try {
      const r = await J(H, "GET", "/open-apis/bitable/v1/apps/" + APP + "/tables/" + tbl + "/fields?page_size=200");
      names = ((r.data || {}).items || []).map((f) => f.field_name);
    } catch (e) { names = null; }
    if (!names || !names.length) { miss.push(label + "：整表读不到字段"); continue; }
    keys.forEach((k) => { if (names.indexOf(k) < 0) miss.push(label + "「" + k + "」"); });
  }
  return { name: "预填键", ok: miss.length === 0, miss,
    msg: miss.length ? "有 " + miss.length + " 个预填键对不上字段：" + miss.join("、") : "全部预填键与字段名一致" };
}

// ── ③ 表单链接可达性：链接是人工维护的，迟早会有人删表单或改分享范围 ──
// 匿名访问，与候选人同等身份 —— 用登录态测是测不出问题的。
function head(url, timeout) {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch (e) { return res({ ok: false, why: "URL 非法" }); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "GET",
      headers: { "User-Agent": "Mozilla/5.0 (portal-healthcheck)" } }, (r) => {
      let b = Buffer.alloc(0);
      r.on("data", (c) => { b = Buffer.concat([b, c]); if (b.length > 120000) r.destroy(); });
      const done = () => {
        const s = b.toString("utf8");
        if (/页面不存在|Page not found|不存在或已被删除|no permission|无权限/i.test(s)) return res({ ok: false, why: "页面不存在或无权限" });
        if (r.statusCode >= 400) return res({ ok: false, why: "HTTP " + r.statusCode });
        res({ ok: true });
      };
      r.on("end", done); r.on("close", done);
    });
    req.on("error", (e) => res({ ok: false, why: String(e.message).slice(0, 40) }));
    req.setTimeout(timeout || 15000, () => { req.destroy(); res({ ok: false, why: "超时" }); });
    req.end();
  });
}

async function formLinks(list) {
  const bad = [];
  for (const it of list) {
    const r = await head(it.url);
    if (!r.ok) bad.push(it.label + "（" + r.why + "）");
    await new Promise((s) => setTimeout(s, 250));   // 别把 Lark 打急了
  }
  return { name: "表单链接", ok: bad.length === 0, total: list.length, bad,
    msg: bad.length ? list.length + " 条里 " + bad.length + " 条打不开：" + bad.join("、") : list.length + " 条全部可达" };
}

// ── ④ 字段契约：产物真的输出了前端要读的字段吗 ──
// 前三道查的都是「Lark → 表单」方向，这一道查「产物 → 前端」方向。
// 为什么需要它：这个方向的故障**全部是静默的**。前端读到 undefined 不会报错，
// 页面照常渲染，只是某个数字变成空白或横杠 —— Actions 一路绿灯，没人会知道。
// 2026-09-04 实例：bench.json 被收窄成只剩 speed（理由是「前端只读 speed」，
// 但那只核对了 join，漏了 agent），星探面板两个主 KPI 的「平均」对比当场失效。
//
// ⚠ 下面这张表是手工维护的。**页面开始读一个新字段时，必须同步加到这里**，
//    否则这道巡检守不住它。日常审计可用 AI CEO 侧的 contract_check 做全量反扫。
// needs = 前端真的读、缺了会坏；allow = 允许存在但前端不读（时间戳之类）。
// public:false 的产物是加密的，只查缺不查多。
const CONTRACT = {
  "bench.json": { public: true, allow: [],
    needs: { "agent/index.html": ["passRate", "hireRate"] } },         // 星探两个主 KPI 的「平均」对比
  "jobs.json": { public: true, allow: ["stamp"],
    needs: { "join/index.html": ["cvForm", "links", "srcOpts", "jobs"] } },
  // 手动维护的对外固定值。不由 sync 生成，所以这里只核对字段齐不齐。
  "manual.json": { public: true, allow: ["_readme"],
    needs: { "join/index.html": ["staff", "speed", "jobs"] } },
  "jobs.json[jobs[0]]": { public: true, allow: [],
    needs: { "join/index.html": ["cn", "id", "goal", "urgent", "track", "open",
                                 "hue", "jd", "jdId", "jid"] } },
  "j/<任一>.json": { public: true, allow: ["movedTo"],                  // movedTo 只有离职者的文件才有
    needs: { "join/index.html": ["name", "byJob"] } },                 // ?a=<经纪人> 解析，缺了全站丢归因
  "s/<任一>.json": { public: true, allow: [],
    needs: { "join/index.html": ["name", "job", "ref"] } },            // ?s=<星探码> 解析
  "p/<任一>.json": { public: false, allow: [],                          // 加密产物，多字段不构成暴露
    needs: { "agent/index.html": ["name", "code", "up", "job", "url", "agg",
                                  "conv", "passRate", "week", "stamp"] } },
};

// samples: { "bench.json": <该产物里前端实际访问的那一层对象>, ... }
// 传对象而不是路径，是因为 p/*.json 落盘时已加密，只能在内存里核对明文。
// samples 的值可以是**一个对象**，也可以是 { 文件名: 对象 } 的整份目录。
// 为什么要支持整份：只抽一个文件会有盲区 —— j/ 目录里在职与离职是两条不同的写入分支，
// 2026-09-05 实测抽到的恰好是离职者的文件，在职者那条分支多输出了字段却没被发现。
function dataContract(samples) {
  const miss = [], extra = [];
  for (const [file, spec] of Object.entries(CONTRACT)) {
    const raw = samples[file];
    if (raw === undefined) { miss.push(file + "：没拿到样本，无法核对"); continue; }
    const many = raw && raw.__all ? raw.__all : { "": raw };
    for (const [fname, obj] of Object.entries(many)) {
    const tag = fname ? file.replace("<任一>", fname.replace(/\.json$/, "")) : file;
    const have = new Set(Object.keys(obj || {}));
    const want = new Set(spec.allow || []);
    for (const [page, keys] of Object.entries(spec.needs)) {
      for (const k of keys) {
        want.add(k);
        if (!have.has(k)) miss.push(tag + "." + k + " ← " + page + " 要读");
      }
    }
    // 反向：公开产物里出现前端不读的字段 = 白扩暴露面。
    // 公开仓库任何人都能下载 data/ 全目录，所以「多输出一个字段」不是无害的冗余，
    // 而是实实在在多泄露一项。加这一半之后，契约表就成了公开产物的字段白名单。
    if (spec.public) for (const k of have) if (!want.has(k)) extra.push(tag + "." + k);
    }
  }
  const parts = [];
  if (miss.length) parts.push("🔴 缺 " + miss.length + " 个前端要读的字段：" + miss.join("、"));
  if (extra.length) parts.push("🟡 公开产物多输出 " + extra.length + " 个前端不读的字段（白扩暴露面）：" + extra.join("、"));
  const uniq = (a) => [...new Set(a)];
  return { name: "字段契约", ok: miss.length === 0 && extra.length === 0,
    miss: uniq(miss), extra: uniq(extra),
    msg: parts.length ? parts.join("；")
                      : Object.keys(CONTRACT).length + " 个产物双向对齐（既不缺、也不多）" };
}

// ── ⑤ 断链：这一轮有没有入口文件消失 ──
// 消失 = 已经发出去、正在流通的那些链接从此打不开。
//
// 为什么需要它：2026-09-05 起死链不再降级成公开入口，而是明确报错（张博定案）。
// 好处是断链对人可见、归因不会被静默转成公司的；代价是**候选人提交不了表单**，
// 于是 A05 里根本不会留下任何痕迹 —— 巡检① 那条「空或 MUKEX」的判据从此看不见断链。
// 这一道把观测点从「事后统计简历」前移到「构建时比对文件」：
// 在任何候选人踩到之前就知道哪些链接死了，比原来更早也更准。
function linksLost(sets) {
  const lost = [];
  for (const [label, s] of Object.entries(sets)) {
    const after = new Set(s.after || []);
    (s.before || []).forEach((k) => { if (!after.has(k)) lost.push(label + "/" + k); });
  }
  // ⚠ msg 会被 sync-portal 打进 **公开的** Actions 日志，所以只放计数。
  //   文件名就是经纪人名字（j/fitri），进公开日志等于点名。细节走 detail，只发到 Lark 群。
  return { name: "断链", ok: lost.length === 0, lost,
    msg: lost.length ? lost.length + " 个入口文件本轮消失，已发出去的对应链接从此打不开" : "入口文件无消失",
    detail: lost.length ? lost.length + " 个入口文件本轮消失：" + lost.join("、") : null };
}

// ── 第 ⑤ 道：A02 已发布，门户却没产出对应的归因码 ──────────────────
//
// 为什么需要它（2026-09-06 删库重建后补）：新经纪人上站依赖两条路径 ——
//   慢路径：GitHub Actions 的 cron，雅加达 10:00–17:00 每整点，共 8 次
//   快路径：Anycross 入职流拿 PAT 调 workflow_dispatch，立刻同步
// 快路径断了（token 过期／被摘掉仓库权限／被撤销）时**没有任何人会知道**：
// Anycross 那一步显示成功，Lark 表里数据齐全，网站只是不更新。
// 删库重建当天就实测到这个：仓库 ID 变了，fine-grained token 的仓库勾选被自动摘掉。
//
// 这一道不去猜 token 状态，而是查**结果**：A02 里标着「发布」且人没离职的经纪人，
// 他的归因码就该出现在某个 j/*.json 的 byJob 值里。查不到 = 他的链接是死的，
// 候选人扫他的码进来会看到「链接无效」。至于是 token 死了还是同步跑挂了，看别的告警。
function publishedNotLive(a02, jAll, V) {
  const live = new Set();
  Object.values((jAll && jAll.__all) || {}).forEach((o) =>
    Object.values((o && o.byJob) || {}).forEach((r) => live.add(String(r))));

  const noRef = [], notLive = [];
  (a02 || []).forEach((r) => {
    const f = r.fields || {};
    if (V(f["T-Status"]).indexOf("发布") < 0) return;      // 只查已发布的
    if (V(f["Emp Status"]).indexOf("离职") >= 0) return;   // 离职的本来就该下站
    const ref = V(f.ARef);
    if (!ref) { noRef.push(1); return; }
    if (!live.has(ref)) notLive.push(ref);
  });

  const bad = noRef.length + notLive.length;
  // msg 进公开日志 → 只放计数；detail 进 Lark 群 → 可带归因码
  //（码本身就在公开链接里，不算秘密；姓名一律不带，群里可能有非管理层成员）。
  return { name: "发布未上站", ok: bad === 0, noRef: noRef.length, notLive,
    msg: bad ? bad + " 个已发布的经纪人在门户里查不到归因码（其中 " + noRef.length + " 个连 ARef 都空）"
             : "已发布的经纪人全部在站",
    detail: bad ? "已发布但门户查不到码：" + (notLive.join("、") || "无")
                + (noRef.length ? "；另有 " + noRef.length + " 个 A02 行没有 ARef" : "")
                + "。先查 Anycross 入职流的 GitHub 触发节点，再看本轮同步有没有跑完。" : null };
}


// ── 汇总成一条群消息。只发结论与数量，不带候选人姓名电话 —— 群里可能有非管理层成员 ──
function compose(results, jkt) {
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return null;
  const lines = ["⚠️ 报名链路巡检发现问题", "", "时间：" + jkt + "（雅加达）", ""];
  // 群消息用 detail（可带细节），没有 detail 的退回 msg。
  // 公开 Actions 日志那边打的是 msg —— 两个出口的详略刻意不同。
  bad.forEach((r) => lines.push("• " + r.name + "：" + (r.detail || r.msg)));
  lines.push("", "报名页本身仍可访问，数据也已更新；以上是链路健康度告警。");
  lines.push("状态看板：https://zanboooo.github.io/muke/status/");
  return lines;
}

module.exports = { attribution, prefillKeys, formLinks, dataContract, linksLost, publishedNotLive, compose };
