#!/usr/bin/env node
// 冒烟测试2：按正确帧协议 [LE32 长度][UTF-8 JSON] 探测 codex-ipc
const net = require("node:net");

const PIPE = "\\\\.\\pipe\\codex-ipc";

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// 流式解码响应帧
function createDecoder(onMsg) {
  let head = Buffer.alloc(4);
  let headFilled = 0;
  let bodyLen = 0;
  let bodyBuf = null;
  let bodyFilled = 0;
  return (chunk) => {
    let pos = 0;
    while (pos < chunk.length) {
      if (bodyLen === 0) {
        const need = 4 - headFilled;
        const take = Math.min(need, chunk.length - pos);
        chunk.copy(head, headFilled, pos, pos + take);
        headFilled += take; pos += take;
        if (headFilled < 4) return;
        bodyLen = head.readUInt32LE(0);
        if (bodyLen === 0 || bodyLen > 268435456) { onMsg(new Error("Invalid frame length " + bodyLen)); return; }
        headFilled = 0;
        bodyBuf = Buffer.alloc(bodyLen);
        bodyFilled = 0;
      } else {
        const take = Math.min(bodyLen - bodyFilled, chunk.length - pos);
        chunk.copy(bodyBuf, bodyFilled, pos, pos + take);
        bodyFilled += take; pos += take;
        if (bodyFilled === bodyLen) {
          const s = bodyBuf.toString("utf8");
          bodyLen = 0;
          try { onMsg(null, JSON.parse(s)); } catch { onMsg(null, s); }
        }
      }
    }
  };
}

function probe(label, payloads, waitMs = 3000) {
  return new Promise((resolve) => {
    const responses = [];
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { sock.destroy(); } catch {}
      resolve({ label, responses });
    };
    const sock = net.createConnection({ path: PIPE });
    const decode = createDecoder((err, msg) => {
      responses.push(err ? ("FRAME_ERR " + err.message) : ("RESPONSE " + JSON.stringify(msg)));
      // 收到响应即可提前结束
      setTimeout(finish, 150);
    });
    sock.on("connect", () => {
      let i = 0;
      const next = () => {
        if (i >= payloads.length) { setTimeout(finish, waitMs); return; }
        sock.write(frame(payloads[i]));
        i++;
        setTimeout(next, 400);
      };
      setTimeout(next, 200);
    });
    sock.on("data", decode);
    sock.on("error", (e) => { responses.push("ERROR " + e.message); finish(); });
    sock.on("close", () => { responses.push("CLOSED"); finish(); });
    setTimeout(finish, waitMs + 2500);
  });
}

(async () => {
  console.log("=== codex-ipc 帧协议探测 ===\n");

  const tests = [
    ["T1: JSON-RPC initialize", [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "smoke", title: "smoke", version: "0.0.1" } } },
    ]],
    ["T2: type=ping", [{ type: "ping" }]],
    ["T3: capnweb 风格", [{ type: "request", id: 1, method: "ping", params: {} }]],
    ["T4: 空 JSON", [{}]],
  ];

  for (const [label, payloads] of tests) {
    const r = await probe(label, payloads);
    console.log(`--- ${label} ---`);
    if (r.responses.length === 0) console.log("  (无响应，连接保持)");
    for (const x of r.responses) console.log("  " + x);
    console.log();
  }
  console.log("=== 完成 ===");
})();
