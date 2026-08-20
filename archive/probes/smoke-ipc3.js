#!/usr/bin/env node
// 冒烟测试3：批量探测握手/注册首帧
const net = require("node:net");

const PIPE = "\\\\.\\pipe\\codex-ipc";

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

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
        const take = Math.min(4 - headFilled, chunk.length - pos);
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

function probe(payload, waitMs = 2000) {
  return new Promise((resolve) => {
    const responses = [];
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { sock.destroy(); } catch {}
      resolve(responses);
    };
    const sock = net.createConnection({ path: PIPE });
    const decode = createDecoder((err, msg) => {
      responses.push(err ? "FRAME_ERR " + err.message : JSON.stringify(msg));
    });
    sock.on("connect", () => setTimeout(() => { sock.write(frame(payload)); }, 150));
    sock.on("data", decode);
    sock.on("error", (e) => { responses.push("ERROR " + e.message); finish(); });
    sock.on("close", () => { responses.push("(closed)"); finish(); });
    setTimeout(finish, waitMs);
  });
}

(async () => {
  const candidates = [
    { type: "connect" },
    { type: "hello" },
    { type: "hello", hostId: "local" },
    { type: "register" },
    { type: "attach" },
    { type: "client-hello", clientId: "smoke-1" },
    { type: "bootstrap" },
    { type: "request", id: 1, method: null },
    { type: "request", id: 1, method: "connect" },
    { type: "request", id: 1, method: "hello" },
    { type: "request", id: 1, method: "initialize", params: {} },
    { type: "request", id: 1, method: "attach", params: { clientId: "smoke-1" } },
    { type: "request", id: 1, method: "bootstrap" },
    { type: "request", id: 1, method: "client/register" },
    { type: "request", id: 1, method: "connectAppHost" },
    { type: "request", id: 1, method: "attachClient", params: { clientId: "smoke-1" } },
  ];

  for (const c of candidates) {
    const r = await probe(c);
    const resp = r.length ? r.join(" | ") : "(无响应,连接保持)";
    console.log(`${JSON.stringify(c).slice(0, 90).padEnd(92)} => ${resp}`);
  }
})();
