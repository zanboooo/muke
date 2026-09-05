// Lark OpenAPI 网络层。两个运行环境共用：
//   · GitHub Actions —— 凭据从环境变量来，DNS 用系统解析
//   · 本机          —— 凭据回落 appkey.txt，DNS 抽风时自动切 8.8.8.8
const https = require("node:https");
const { Resolver } = require("node:dns");

const rsv = new Resolver();
rsv.setServers(["8.8.8.8", "1.1.1.1"]);

// 先用系统解析；失败才走公共 DNS。本机 DNS 对 open.larksuite.com 抽风时的兜底（2026-08-28）。
let useFallback = false;
function lookup(hostname, options, cb) {
  if (!useFallback) {
    return require("node:dns").lookup(hostname, options, (e, a, f) => {
      if (!e) return cb(null, a, f);
      useFallback = true;
      resolveVia(hostname, options, cb);
    });
  }
  resolveVia(hostname, options, cb);
}
function resolveVia(hostname, options, cb) {
  rsv.resolve4(hostname, (err, addrs) => {
    if (err || !addrs || !addrs.length) return cb(err || new Error("no A record"));
    if (options && options.all) return cb(null, addrs.map(a => ({ address: a, family: 4 })));
    cb(null, addrs[0], 4);
  });
}

function J(H, method, path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "open.larksuite.com", path, method, lookup, timeout: 30000,
      headers: Object.assign({}, H, data ? { "Content-Length": Buffer.byteLength(data) } : {})
    }, r => {
      // ⚠ 必须先攒 Buffer 再整体解码。写成 buf += c 会让每个 chunk 各自 toString("utf8")，
      //   一个中文字若被 TCP 分块切开，两半各自解码成 U+FFFD —— 表现为时有时无的乱码。
      //   2026-09-04 实测：线上 jobs.json 的「直播间搭建调试」多次被写成「直播间??建调试」，
      //   历史提交里乱码忽有忽无正是分块位置漂移所致。姓名／岗位名同样会被污染。
      const chunks = [];
      r.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      r.on("end", () => { const buf = Buffer.concat(chunks).toString("utf8");
        try { res(JSON.parse(buf)); } catch (e) { rej(new Error("非JSON响应 " + r.statusCode + " " + buf.slice(0, 200))); } });
    });
    req.on("timeout", () => req.destroy(new Error("请求超时 30s")));
    req.on("error", rej);
    if (data) req.write(data);
    req.end();
  });
}

function creds() {
  if (process.env.LARK_APP_ID && process.env.LARK_APP_SECRET)
    return { app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET, from: "env" };
  const fs = require("fs");
  for (const p of ["appkey.txt", "../appkey.txt", "D:/项目/AI CEO/appkey.txt"]) {
    try { const k = JSON.parse(fs.readFileSync(p, "utf8").replace(/^\ufeff/, "")); return { ...k, from: p }; } catch (e) { }
  }
  throw new Error("拿不到凭据：请设 LARK_APP_ID / LARK_APP_SECRET 环境变量，或放 appkey.txt");
}

async function auth() {
  const k = creds();
  const t = await J({ "Content-Type": "application/json" }, "POST",
    "/open-apis/auth/v3/tenant_access_token/internal", { app_id: k.app_id, app_secret: k.app_secret });
  if (!t.tenant_access_token) throw new Error("取 token 失败 code=" + t.code + " " + (t.msg || ""));
  return { Authorization: "Bearer " + t.tenant_access_token, "Content-Type": "application/json" };
}

module.exports = { J, auth, creds };
