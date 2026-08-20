import fs from 'fs';
import path from 'path';
import {
  RelayError,
  hashSecret,
  isNonEmptyString,
  normalizeInviteCode,
  normalizePairCode,
  nowIso,
  nowMs,
  randomDeviceId,
  randomInviteCode,
  randomPairCode,
  randomToken,
  safeEqual
} from './util.js';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    this.state = emptyState();
    this.tokenIndex = new Map();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.statePath)) {
      this.persist();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.state = {
        invites: raw.invites || {},
        hubs: raw.hubs || {},
        pairCodes: raw.pairCodes || {},
        devices: raw.devices || {},
        pushDevices: raw.pushDevices || {}
      };
    } catch {
      this.state = emptyState();
    }
    this.reindex();
  }

  persist() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    try {
      fs.renameSync(tmp, this.statePath);
    } catch {
      fs.copyFileSync(tmp, this.statePath);
      fs.unlinkSync(tmp);
    }
  }

  reindex() {
    this.tokenIndex.clear();
    for (const device of Object.values(this.state.devices)) {
      if (device?.tokenHash) this.tokenIndex.set(device.tokenHash, device.id);
    }
  }

  createInvite({ note = '', ttlSec = 0 } = {}) {
    let code = randomInviteCode();
    while (this.state.invites[code]) code = randomInviteCode();
    const createdAt = nowIso();
    const rec = {
      code,
      note: String(note || ''),
      createdAt,
      expiresAt: ttlSec > 0 ? nowIso(nowMs() + ttlSec * 1000) : null,
      consumedAt: null,
      revokedAt: null,
      hubId: null
    };
    this.state.invites[code] = rec;
    this.persist();
    return rec;
  }

  listInvites() {
    return Object.values(this.state.invites);
  }

  getInvite(code) {
    return this.state.invites[normalizeInviteCode(code)] || null;
  }

  revokeInvite(code) {
    const rec = this.getInvite(code);
    if (!rec) throw new RelayError('not_found', 'invite not found', 404);
    rec.revokedAt = nowIso();
    this.persist();
    return rec;
  }

  activeHubCount() {
    return Object.keys(this.state.hubs).length;
  }

  getHub(hubId) {
    return this.state.hubs[hubId] || null;
  }

  listHubs() {
    return Object.values(this.state.hubs);
  }

  verifyHub(hubId, hubSecret) {
    const hub = this.getHub(hubId);
    if (!hub) throw new RelayError('unknown_hub', 'unknown hub', 404);
    if (!safeEqual(hub.secretHash, hashSecret(hubSecret))) {
      throw new RelayError('unauthorized', 'invalid hub secret', 401);
    }
    return hub;
  }

  registerHub({ hubId, hubSecret, inviteCode, maxHubs, hubE2ePub = '' }) {
    if (!isNonEmptyString(hubId)) throw new RelayError('bad_envelope', 'hubId required');
    if (!isNonEmptyString(hubSecret) || hubSecret.length < 16) {
      throw new RelayError('unauthorized', 'hubSecret required', 401);
    }
    const existing = this.getHub(hubId);
    if (existing) {
      if (!safeEqual(existing.secretHash, hashSecret(hubSecret))) {
        throw new RelayError('unauthorized', 'invalid hub secret', 401);
      }
      existing.lastSeenAt = nowIso();
      if (hubE2ePub) existing.e2ePub = String(hubE2ePub);
      this.persist();
      return existing;
    }
    if (maxHubs && this.activeHubCount() >= maxHubs) {
      throw new RelayError('quota_exceeded', 'hub quota exceeded', 403);
    }
    const invite = this.consumeInvite(inviteCode, hubId);
    const rec = {
      hubId,
      secretHash: hashSecret(hubSecret),
      inviteCode: invite.code,
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
      e2ePub: String(hubE2ePub || '')
    };
    this.state.hubs[hubId] = rec;
    this.persist();
    return rec;
  }

  consumeInvite(code, hubId) {
    if (!isNonEmptyString(code)) {
      throw new RelayError('invite_required', 'invite code required for first registration', 403);
    }
    const rec = this.getInvite(code);
    if (!rec || rec.revokedAt) throw new RelayError('invite_invalid', 'invalid invite', 403);
    if (rec.expiresAt && Date.parse(rec.expiresAt) <= nowMs()) {
      throw new RelayError('invite_invalid', 'invite expired', 403);
    }
    if (rec.consumedAt) throw new RelayError('invite_invalid', 'invite already used', 403);
    rec.consumedAt = nowIso();
    rec.hubId = hubId;
    return rec;
  }

  touchHub(hubId) {
    const hub = this.getHub(hubId);
    if (!hub) return;
    hub.lastSeenAt = nowIso();
    this.persist();
  }

  createPairCode({ hubId, ttlSec, hubE2ePub = '' }) {
    if (!this.getHub(hubId)) throw new RelayError('unknown_hub', 'unknown hub', 404);
    let code = randomPairCode();
    while (this.state.pairCodes[code]) code = randomPairCode();
    const hub = this.getHub(hubId);
    if (hubE2ePub) hub.e2ePub = String(hubE2ePub);
    const rec = {
      code,
      hubId,
      hubE2ePub: String(hubE2ePub || hub.e2ePub || ''),
      createdAt: nowIso(),
      expiresAt: nowIso(nowMs() + Math.max(30, ttlSec || 600) * 1000),
      usedAt: null
    };
    this.state.pairCodes[code] = rec;
    this.persist();
    return rec;
  }

  redeemPairCode(code) {
    const key = normalizePairCode(code);
    const rec = this.state.pairCodes[key];
    if (!rec || rec.usedAt) throw new RelayError('invalid_code', 'invalid pairing code', 401);
    if (Date.parse(rec.expiresAt) <= nowMs()) {
      throw new RelayError('invalid_code', 'pairing code expired', 401);
    }
    if (!this.getHub(rec.hubId)) throw new RelayError('unknown_hub', 'unknown hub', 404);
    rec.usedAt = nowIso();
    const token = randomToken();
    const device = {
      id: randomDeviceId(),
      hubId: rec.hubId,
      tokenHash: hashSecret(token),
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
      revokedAt: null
    };
    this.state.devices[device.id] = device;
    this.tokenIndex.set(device.tokenHash, device.id);
    this.persist();
    return {
      device,
      deviceToken: token,
      hubId: rec.hubId,
      hubE2ePub: rec.hubE2ePub || this.getHub(rec.hubId)?.e2ePub || ''
    };
  }

  getDevice(deviceId) {
    return this.state.devices[deviceId] || null;
  }

  getDeviceByToken(token) {
    if (!isNonEmptyString(token)) return null;
    const id = this.tokenIndex.get(hashSecret(token));
    if (!id) return null;
    return this.state.devices[id] || null;
  }

  requireDevice(token) {
    const device = this.getDeviceByToken(token);
    if (!device) throw new RelayError('unauthorized', 'invalid device token', 401);
    if (device.revokedAt) throw new RelayError('revoked', 'device revoked', 403);
    return device;
  }

  listDevices(hubId) {
    const all = Object.values(this.state.devices);
    return hubId ? all.filter((d) => d.hubId === hubId) : all;
  }

  touchDevice(deviceId) {
    const device = this.getDevice(deviceId);
    if (!device) return;
    device.lastSeenAt = nowIso();
    this.persist();
  }

  revokeDevice(deviceId) {
    const device = this.getDevice(deviceId);
    if (!device) throw new RelayError('not_found', 'device not found', 404);
    device.revokedAt = nowIso();
    this.persist();
    return device;
  }

  revokeToken(token) {
    const device = this.requireDevice(token);
    return this.revokeDevice(device.id);
  }

  bindPushDevice(hubId, registrationId) {
    const id = String(registrationId || '').trim();
    if (!isNonEmptyString(hubId) || !this.getHub(hubId)) {
      throw new RelayError('unknown_hub', 'unknown hub', 404);
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
      throw new RelayError('bad_envelope', 'invalid registrationId');
    }
    this.state.pushDevices[id] = { hubId, updatedAt: nowIso() };
    this.persist();
    return this.state.pushDevices[id];
  }

  listPushIds(hubId) {
    return Object.entries(this.state.pushDevices)
      .filter(([, rec]) => rec && rec.hubId === hubId)
      .map(([id]) => id);
  }
}

function emptyState() {
  return { invites: {}, hubs: {}, pairCodes: {}, devices: {}, pushDevices: {} };
}
