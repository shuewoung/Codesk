import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const fail = (code, message) => Object.assign(new Error(message), { code });
export function validId(value, name = 'id') {
  if (typeof value !== 'string' || ['__proto__', 'constructor', 'prototype', 'toString'].includes(value) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value)) throw fail('INVALID_REQUEST', `${name} invalid`);
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
function validError(value) {
  return plainObject(value) && (value.code == null || typeof value.code === 'string' || Number.isSafeInteger(value.code)) && (value.message == null || typeof value.message === 'string');
}
function validateCommand(record, key) {
  if (!plainObject(record) || record.requestId !== key || typeof record.hash !== 'string' || !/^[a-f0-9]{64}$/.test(record.hash) || !['pending', 'running', 'succeeded', 'failed', 'uncertain'].includes(record.status) || !timestamp(record.createdAt)) throw new Error('Invalid command record');
  validId(key); validId(record.threadId);
  if (record.clientUserMessageId != null) validId(record.clientUserMessageId);
  if (record.updatedAt != null && !timestamp(record.updatedAt)) throw new Error('Invalid command timestamp');
  if ((record.status === 'succeeded' || record.result != null) && !plainObject(record.result)) throw new Error('Invalid command result');
  if ((['failed', 'uncertain'].includes(record.status) || record.error != null) && !validError(record.error)) throw new Error('Invalid command error');
}
function validateStore(data) {
  try {
    if (!plainObject(data) || data.version !== 1 || !['commands', 'queue', 'drafts'].every(key => plainObject(data[key]))) throw new Error('Invalid top-level store');
    for (const [key, record] of Object.entries(data.commands)) validateCommand(record, key);
    for (const [key, record] of Object.entries(data.drafts)) {
      validId(key);
      if (!plainObject(record) || !Number.isSafeInteger(record.version) || record.version < 1 || typeof record.text !== 'string' || record.text.length > 200000 || !Array.isArray(record.attachments) || record.attachments.length > 32 || !record.attachments.every(plainObject) || Buffer.byteLength(JSON.stringify(record.attachments)) > 256 * 1024 || !timestamp(record.updatedAt)) throw new Error('Invalid draft record');
    }
    for (const [key, record] of Object.entries(data.queue)) {
      validId(key);
      if (!plainObject(record) || record.queueId !== key || record.requestId !== key || !['queued', 'sending', 'sent', 'failed', 'uncertain', 'cancelled'].includes(record.status) || !timestamp(record.createdAt) || typeof record.text !== 'string' || record.text.length > 200000) throw new Error('Invalid queue record');
      validId(record.threadId);
      if (record.clientUserMessageId != null) validId(record.clientUserMessageId);
      const payload = record.payload;
      if (!plainObject(payload) || payload.type !== 'send_message' || payload.requestId !== key || payload.threadId !== record.threadId || payload.clientUserMessageId !== record.clientUserMessageId || (payload.text != null && (typeof payload.text !== 'string' || payload.text.length > 200000)) || (payload.input != null && (!Array.isArray(payload.input) || payload.input.length > 32)) || Buffer.byteLength(JSON.stringify(payload)) > 1024 * 1024) throw new Error('Invalid queue payload');
      if (record.command != null) validateCommand(record.command, record.command.requestId);
      if (record.error != null && !validError(record.error)) throw new Error('Invalid queue error');
    }
  } catch { throw fail('STORE_CORRUPT', 'Invalid workbench store structure; refusing replay'); }
}

export class CommandStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'workbench-v1.json');
    this.tails = new Map(); this.active = new Map();
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw fail('STORE_CORRUPT', 'Workbench store unreadable; refusing replay'); this.data = { version: 1, commands: {}, drafts: {}, queue: {} }; }
    validateStore(this.data);
    for (const c of Object.values(this.data.commands)) if (['pending', 'running'].includes(c.status)) { c.status = 'uncertain'; c.error = { code: 'RESTART_UNCERTAIN', message: 'Hub restarted; inspect history before a new send' }; }
    for (const q of Object.values(this.data.queue)) if (q.status === 'sending') q.status = 'uncertain';
    this.persist();
  }
  assertHealthy() { if (this.fault) throw fail('STORE_UNAVAILABLE', 'Persistence failed; restart after repairing storage, no commands replayed'); }
  persist() {
    this.assertHealthy();
    try { this.writeSnapshot(); }
    catch (error) {
      this.fault = error;
      if (this.lastPersisted) this.data = JSON.parse(this.lastPersisted);
      throw error;
    }
  }
  writeSnapshot() {
    const json = JSON.stringify(this.data);
    if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw fail('STORE_FULL', 'Workbench storage limit reached');
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    let fd;
    try { fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, json); fs.fsyncSync(fd); fs.closeSync(fd); fd = null; fs.renameSync(tmp, this.file); this.lastPersisted = json; }
    finally { if (fd != null) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
  }
  serial(threadId, fn) {
    const previous = this.tails.get(threadId) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.tails.set(threadId, next);
    next.finally(() => { if (this.tails.get(threadId) === next) this.tails.delete(threadId); }).catch(() => {});
    return next;
  }
  query(id) { validId(id, 'requestId'); return structuredClone(Object.hasOwn(this.data.commands, id) ? this.data.commands[id] : null); }
  async execute(msg, fn, { inLane = false } = {}) {
    this.assertHealthy();
    const id = validId(msg.requestId || msg.clientUserMessageId, 'requestId');
    validId(msg.threadId, 'threadId');
    if (msg.clientUserMessageId != null) validId(msg.clientUserMessageId, 'clientUserMessageId');
    const payload = { ...msg }; delete payload.requestId;
    const hash = crypto.createHash('sha256').update(canonical(payload)).digest('hex');
    let existing = Object.hasOwn(this.data.commands, id) ? this.data.commands[id] : null;
    if (!existing && msg.clientUserMessageId) existing = Object.values(this.data.commands).find(c => c.clientUserMessageId === msg.clientUserMessageId);
    if (existing) {
      if (existing.hash !== hash) throw fail('IDEMPOTENCY_CONFLICT', 'Same command ID used with different payload');
      if (!inLane && this.active.has(existing.requestId)) await this.active.get(existing.requestId);
      return this.query(existing.requestId);
    }
    if (Object.keys(this.data.commands).length >= 10000) throw fail('STORE_FULL', 'Command limit reached; IDs are never silently evicted');
    const c = { requestId: id, clientUserMessageId: msg.clientUserMessageId, threadId: msg.threadId, hash, status: 'pending', createdAt: Date.now() };
    Object.defineProperty(this.data.commands, id, { value: c, enumerable: true, configurable: true, writable: true });
    this.persist();
    const run = async () => {
      c.status = 'running'; this.persist();
      try {
        const result = await fn();
        if (!plainObject(result)) throw fail('EXECUTION_UNCERTAIN', 'Command returned an invalid result');
        c.result = result;
        c.status = c.result?.status === 'error' ? (c.result?.uncertain === false ? 'failed' : 'uncertain') : 'succeeded';
        if (c.status !== 'succeeded') c.error = { code: c.result.code || 'SEND_FAILED', message: c.result.message };
      } catch (e) { c.status = 'uncertain'; c.error = { code: e.code || 'EXECUTION_UNCERTAIN', message: e.message }; }
      c.updatedAt = Date.now(); this.persist();
    };
    const task = inLane ? Promise.resolve().then(run) : this.serial(msg.threadId, run);
    this.active.set(id, task);
    try { await task; return this.query(id); } finally { this.active.delete(id); }
  }
}
