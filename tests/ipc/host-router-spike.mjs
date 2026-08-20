#!/usr/bin/env node
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIPE = "\\\\.\\pipe\\codex-ipc";
const HOST_ID = "local";
const VERSIONS = {
  initialize: 0,
  "thread-owner-discovery": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-interrupt-turn-compat": 3,
};
const here = path.dirname(fileURLToPath(import.meta.url));

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function createDecoder(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len === 0 || len > 45 * 1024 * 1024) {
        onMsg(new Error(`invalid frame length ${len}`));
        return;
      }
      if (buf.length < 4 + len) return;
      const json = buf.subarray(4, 4 + len).toString("utf8");
      buf = buf.subarray(4 + len);
      try {
        onMsg(null, JSON.parse(json));
      } catch (error) {
        onMsg(error);
      }
    }
  };
}

function defaultThreadId() {
  if (process.env.CODEX_THREAD_ID?.trim()) return process.env.CODEX_THREAD_ID.trim();
  const artifact = path.resolve(
    here,
    "../artifacts/session-count.json",
  );
  if (fs.existsSync(artifact)) {
    const data = JSON.parse(fs.readFileSync(artifact, "utf8"));
    return data.projectThreads?.[0]?.id || null;
  }
  return null;
}

function brief(msg) {
  const text = JSON.stringify(msg);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

async function main() {
  const conversationId = process.argv[2] || defaultThreadId();
  const doInterrupt = process.argv.includes("--interrupt");
  const report = {
    pipe: PIPE,
    conversationId,
    initialize: null,
    discovery: null,
    interrupt: null,
    broadcasts: [],
    errors: [],
  };

  if (!conversationId) {
    console.error("FAIL A: missing conversationId (pass thread id or set CODEX_THREAD_ID)");
    process.exit(2);
  }

  const sock = net.createConnection({ path: PIPE });
  const pending = new Map();
  const clientId = { current: "initializing-client" };

  const send = (method, params, extra = {}) => {
    const requestId = crypto.randomUUID();
    const version =
      method === "thread-follower-interrupt-turn" && !params?.expectedTurnId
        ? VERSIONS["thread-follower-interrupt-turn-compat"]
        : (VERSIONS[method] ?? 0);
    const payload = {
      type: "request",
      requestId,
      sourceClientId: clientId.current,
      version,
      method,
      params,
      ...extra,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`timeout waiting for ${method}`));
      }, extra.timeoutMs || 8000);
      pending.set(requestId, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      sock.write(frame(payload));
    });
  };

  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
    setTimeout(() => reject(new Error("pipe connect timeout")), 3000);
  });
  console.log("PASS connect", PIPE);

  sock.on("data", createDecoder((err, msg) => {
    if (err) {
      report.errors.push(err.message);
      return;
    }
    if (msg?.type === "client-discovery-request") {
      sock.write(frame({
        type: "client-discovery-response",
        requestId: msg.requestId,
        response: { canHandle: false },
      }));
      return;
    }
    if (msg?.type === "broadcast") {
      report.broadcasts.push({
        method: msg.method,
        sourceClientId: msg.sourceClientId,
        params: msg.params || null,
      });
      console.log("broadcast", msg.method, msg.sourceClientId || "", brief(msg.params || {}));
      return;
    }
    const waiter = pending.get(msg?.requestId);
    if (waiter) {
      pending.delete(msg.requestId);
      waiter.resolve(msg);
    } else {
      console.log("unsolicited", brief(msg));
    }
  }));

  try {
    const init = await send("initialize", { clientType: "vscode" });
    report.initialize = init;
    const assigned = init?.result?.clientId || init?.handledByClientId;
    if (init?.resultType !== "success" || !assigned) {
      console.error("FAIL A initialize", brief(init));
      process.exit(3);
    }
    clientId.current = assigned;
    console.log("PASS A initialize clientId=", assigned);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const hostIds = [...new Set([HOST_ID, "local", "desktop", ""])];
    const seenThreadIds = [
      conversationId,
      ...report.broadcasts.flatMap((item) => {
        const params = item.params || {};
        return [params.conversationId, params.threadId].filter(Boolean);
      }),
    ];
    let discovery = null;
    for (const hostId of hostIds) {
      for (const threadId of [...new Set(seenThreadIds)]) {
        console.log("try discovery", { hostId, threadId });
        const attempt = await send(
          "thread-owner-discovery",
          { hostId, conversationId: threadId },
          { timeoutMs: 5000 },
        );
        report.discoveryAttempts = report.discoveryAttempts || [];
        report.discoveryAttempts.push({ hostId, threadId, response: attempt });
        if (attempt?.resultType !== "error" && attempt?.handledByClientId) {
          discovery = attempt;
          report.conversationId = threadId;
          break;
        }
        console.log("  ", attempt?.error || brief(attempt));
      }
      if (discovery) break;
    }
    report.discovery = discovery;
    if (discovery?.resultType === "error") {
      console.error("FAIL A discovery", discovery.error, brief(discovery));
      writeReport(report);
      process.exit(4);
    }
    const ownerId = discovery?.handledByClientId;
    if (!ownerId) {
      console.error("FAIL A discovery: no handledByClientId", brief(discovery));
      writeReport(report);
      process.exit(4);
    }
    console.log("PASS A discovery owner=", ownerId, "thread=", report.conversationId);

    if (doInterrupt) {
      const interrupt = await send(
        "thread-follower-interrupt-turn",
        { conversationId },
        { targetClientId: ownerId, timeoutMs: 8000 },
      );
      report.interrupt = interrupt;
      if (interrupt?.resultType === "error") {
        console.error("FAIL B interrupt", interrupt.error, brief(interrupt));
        writeReport(report);
        process.exit(5);
      }
      console.log("PASS B interrupt", brief(interrupt));
    } else {
      console.log("SKIP B (pass --interrupt to send thread-follower-interrupt-turn)");
    }

    writeReport(report);
    console.log("SPIKE OK");
    sock.destroy();
    process.exit(0);
  } catch (error) {
    report.errors.push(error.message);
    console.error("FAIL", error.message);
    writeReport(report);
    sock.destroy();
    process.exit(1);
  }
}

function writeReport(report) {
  const outDir = path.resolve(here, "../artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "host-router-spike.json");
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log("wrote", out);
}

main();
