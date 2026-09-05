// 连通性自检：只验「能不能连上、能不能读表」，不输出任何业务内容。
// 公开仓库的 Actions 日志是公开的 —— 这里只准打印计数。
const { J, auth, creds } = require("./_net.js");
const BASE = process.env.LARK_BASE_TOKEN;
const T = { A01: "tblDDCntGCkEmWnK", H22: "tblkIVU61UVMoraT" };

(async () => {
  const t0 = Date.now();
  console.log("① 凭据来源：" + creds().from);

  const H = await auth();
  console.log("② tenant_access_token  ✅  (" + (Date.now() - t0) + "ms)");

  if (!BASE) throw new Error("缺 LARK_BASE_TOKEN");
  const tabs = await J(H, "GET", "/open-apis/bitable/v1/apps/" + BASE + "/tables?page_size=100");
  if (tabs.code) throw new Error("读表列表失败 code=" + tabs.code + " " + tabs.msg);
  console.log("③ Base 可读，共 " + tabs.data.items.length + " 张表  ✅");

  for (const [name, id] of Object.entries(T)) {
    const r = await J(H, "POST", "/open-apis/bitable/v1/apps/" + BASE + "/tables/" + id + "/records/search?page_size=500", {});
    if (r.code) throw new Error(name + " 读取失败 code=" + r.code);
    console.log("④ " + name + " 记录 " + r.data.items.length + " 行  ✅");
  }
  console.log("\n🎯 连通性正常，耗时 " + (Date.now() - t0) + "ms");
})().catch(e => { console.error("🔴 " + e.message); process.exit(1); });
