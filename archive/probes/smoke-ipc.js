#!/usr/bin/env node
// 冒烟测试：探测 \\.\pipe\codex-ipc 的协议行为
// 阶段A: 静默监听（服务端是否主动推送）
// 阶段B: JSON-RPC newline-delimited 探测（codex app-server 标准协议）
// 阶段C: LSP 风格 Content-Length 帧探测
// 阶段D: 裸文本探测
const net = require("node:net");

const PIPE = "\\\\.\\pipe\\codex-ipc";
const LISTEN_MS = 2500;

function hex(buf) {
  return Array.from(buf.slice(0, 128))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}
function utf8(buf) {
  const s = buf.toString("utf8");
  // 只保留可打印字符
  return s.replace(/[^\x20-\x7e]/g, "·").slice(0, 256);
}

function runProbe(label, { silenceMs = 0, writeChunks = [] }) {
  return new Promise((resolve) => {
    const events = [];
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve({ label, verdict, events });
    };

    const sock = net.createConnection({ path: PIPE });
    sock.on("connect", () => {
      events.push("CONNECTED");
      if (silenceMs > 0) {
        // 阶段A：先静默听
        setTimeout(() => {
          if (settled) return;
          if (writeChunks.length === 0) {
            finish(events.length > 1 ? "SERVER_PUSHED" : "SILENT");
            return;
          }
          sendNext(0);
        }, silenceMs);
      } else {
        sendNext(0);
      }
    });

    function sendNext(i) {
      if (i >= writeChunks.length) {
        // 发完所有探测帧后等待响应
        setTimeout(() => {
          const gotData = events.some((e) => e.startsWith("DATA"));
          finish(gotData ? "RESPONDED" : "NO_RESPONSE");
        }, LISTEN_MS);
        return;
      }
      const { desc, data } = writeChunks[i];
      events.push("WRITE " + desc);
      sock.write(data);
      setTimeout(() => sendNext(i + 1), 300);
    }

    sock.on("data", (buf) => {
      events.push("DATA len=" + buf.length + " hex=" + hex(buf));
      events.push("     utf8=" + utf8(buf));
    });
    sock.on("error", (err) => {
      events.push("ERROR " + err.message);
      finish("ERROR");
    });
    sock.on("close", () => {
      events.push("CLOSED_BY_SERVER");
      finish(events.some((e) => e.startsWith("DATA")) ? "RESPONDED_THEN_CLOSED" : "CLOSED_IMMEDIATELY");
    });
  });
}

const jsonRpcInit =
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "smoke-test", title: "smoke", version: "0.0.1" } },
  }) + "\n";

const lspBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
const lspFrame = `Content-Length: ${Buffer.byteLength(lspBody)}\r\n\r\n${lspBody}`;

(async () => {
  console.log("=== codex-ipc 冒烟测试 ===\n");

  const probes = [
    { label: "A: 静默监听 2.5s", opts: { silenceMs: LISTEN_MS, writeChunks: [] } },
    { label: "B: JSON-RPC (newline)", opts: { silenceMs: 300, writeChunks: [{ desc: "jsonrpc initialize", data: jsonRpcInit }] } },
    { label: "C: LSP Content-Length 帧", opts: { silenceMs: 300, writeChunks: [{ desc: "lsp frame", data: lspFrame }] } },
    { label: "D: 裸文本 ping", opts: { silenceMs: 300, writeChunks: [{ desc: "raw text", data: "ping\n" }] } },
  ];

  for (const p of probes) {
    console.log(`--- ${p.label} ---`);
    const r = await runProbe(p.label, p.opts);
    for (const e of r.events) console.log("  " + e);
    console.log(`  => ${r.verdict}\n`);
  }

  console.log("=== 完成 ===");
})();
