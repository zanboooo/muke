// 往 Lark 群丢一条通知。两种用法：
//   ① 被 require：用 send(lines) 发任意内容（checks.js 的巡检告警走这条）
//   ② 被直接执行：读环境变量 FAIL_REASON 发「同步失败」模板（Actions 失败分支的老用法，未改）
//
// 为什么需要它：Actions 失败只会给仓库 owner 发邮件，漏看了就可能连着几天不同步而不自知。
// 报名页不会挂（页面显示上一次的数据），但岗位变化不生效 —— 属于「安静地不干活」，最难发现。
//
// 没配 LARK_ALERT_CHAT_ID 就把内容打到日志、返回 false，绝不抛错 —— 通知失败不能让主流程更红。
const { J, auth } = require("./_net.js");
const CHAT = process.env.LARK_ALERT_CHAT_ID;

async function send(lines) {
  const body = Array.isArray(lines) ? lines.join("\n") : String(lines);
  if (!CHAT) {
    // ⚠ 2026-09-06：**公开仓库的 Actions 日志任何人可读**。原先这里会把整条通知内容
    // 打进日志 —— 而 checks.js 的巡检告警里含经纪人姓名与归因码。于是「配漏一个 Secret」
    // 这个最可能的人为失误，会从「没通知」升级成「泄露」。
    // Actions 里只打计数；本机跑照旧打全文（本机日志不公开，方便排错）。
    if (process.env.GITHUB_ACTIONS) {
      console.log("（未配 LARK_ALERT_CHAT_ID，内容已丢弃，共 " + body.split("\n").length + " 行）");
    } else {
      console.log("（未配 LARK_ALERT_CHAT_ID，以下内容未发送）\n" + body);
    }
    return false;
  }
  try {
    const H = await auth();
    const r = await J(H, "POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", {
      receive_id: CHAT, msg_type: "text",
      content: JSON.stringify({ text: body }),
    });
    if (r.code) { console.log("通知发送失败 code=" + r.code + " " + (r.msg || "")); return false; }
    console.log("已通知 Lark 群");
    return true;
  } catch (e) { console.log("通知异常：" + e.message); return false; }
}

module.exports = { send };

// ── 以下仅在「直接执行本文件」时运行（Actions 的失败分支，行为与改造前一致） ──
if (require.main === module) {
  (async () => {
    const repo = process.env.GITHUB_REPOSITORY || "zanboooo/muke";
    const runId = process.env.GITHUB_RUN_ID || "";
    const url = "https://github.com/" + repo + "/actions" + (runId ? "/runs/" + runId : "");
    const why = process.env.FAIL_REASON || "同步流程中止";
    const jkt = new Date(Date.now() + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 16);

    // 只发状态与链接，不带任何业务内容 —— 群里可能有非管理层成员
    await send([
      "🔴 报名页同步失败",
      "",
      "时间：" + jkt + "（雅加达）",
      "原因：" + String(why).slice(0, 200),
      "",
      "报名页不受影响，仍显示上一次的数据；但岗位变化不会生效。",
      "查看详情：" + url,
    ]);
  })().catch((e) => { console.log("通知异常：" + e.message); });
}
