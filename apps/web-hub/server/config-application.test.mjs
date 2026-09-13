import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CodexAppServer, isNoActiveTurnError } from './appserver.js';
import { correlationFields } from './file-access.js';

const source = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesk-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'model = "fixture-model"\nmodel_reasoning_effort = "high"\nservice_tier = "fast"\n');
  const replies = [];
  const context = vm.createContext({ fs, CONFIG_TOML_PATH: file, console: { log() {}, warn() {}, error() {} }, isNoActiveTurnError,
    correlationFields, broadcastToClients: p => replies.push(p), accountQuotaCache: { value: {} }, localHostName: () => 'fixture', identity: { hubId: 'fixture' }, workbenchCapabilities: () => ({}) });
  vm.runInContext(section('function readCodexConfig()', 'const rolloutCache ='), context);
  vm.runInContext(section('async function sendLocalUserOrSteer(', 'function rolloutLooksLive('), context);
  vm.runInContext(section('async function handleLegacyClientMessage(', 'function fileAccessFor('), context);
  return { context, file, replies };
}

test('local new turn submits fresh saved model/effort through existing appserver API only', async t => {
  const f = setup(t), requests = [];
  const client = new CodexAppServer();
  // Inject only the RPC transport: no startup, subprocess, IPC or model task.
  client.client.request = async (method, params) => { requests.push({ method, params }); return { turn: { id: 'fixture-turn', status: 'completed' } }; };
  await f.context.sendLocalUserOrSteer(client, 'thread', 'hello', null, false, { clientUserMessageId: 'stable' });
  assert.equal(requests[0].method, 'turn/start');
  assert.equal(requests[0].params.model, 'fixture-model'); assert.equal(requests[0].params.effort, 'high');
  assert.equal(requests[0].params.clientUserMessageId, 'stable'); assert.equal(requests[0].params.serviceTier, null);
  f.context.updateCodexConfig('model', 'next-model'); f.context.updateCodexConfig('effort', 'low');
  await f.context.sendLocalUserOrSteer(client, 'thread', 'next', null, false);
  assert.equal(requests[1].params.model, 'next-model'); assert.equal(requests[1].params.effort, 'low');
});

test('new-turn raw/fallback/default settings preserve null inheritance and explicit none effort', async t => {
  const f = setup(t); let params;
  const client = { currentTurnByThread: new Map(), sendUserTurn: async p => { params = p; } };
  for (const [cfg, expected] of [
    [{ rawModel: 'raw', model: 'display', rawEffort: 'none', effort: 'high' }, ['raw', 'none']],
    [{ model: 'fallback', effort: 'medium' }, ['fallback', 'medium']],
    [{ rawModel: 'default', rawEffort: 'default' }, [null, null]],
    [{ rawModel: null, rawEffort: null }, [null, null]],
    [{ rawModel: '', rawEffort: '' }, [null, null]],
  ]) {
    f.context.readCodexConfig = () => cfg;
    await f.context.sendLocalUserOrSteer(client, 'thread', 'hello', null, false);
    assert.deepEqual([params.model, params.effort], expected);
  }
});

test('active steer does not claim to apply model/effort or speed to current turn', async t => {
  const f = setup(t); let params;
  f.context.readCodexConfig = () => { throw new Error('active turn must not read new config'); };
  const client = { currentTurnByThread: new Map([['thread', 'active']]), steerTurn: async p => { params = p; } };
  assert.equal(await f.context.sendLocalUserOrSteer(client, 'thread', 'hello', null, true), 'steer');
  assert.equal(Object.hasOwn(params, 'model'), false); assert.equal(Object.hasOwn(params, 'effort'), false); assert.equal(Object.hasOwn(params, 'serviceTier'), false);
});

test('configuration replies distinguish saved from execution confirmation including speed', async t => {
  const f = setup(t); const ws = { send: p => f.replies.push(JSON.parse(p)) };
  await f.context.handleLegacyClientMessage(ws, { type: 'update_config', key: 'speed', value: 'fast' });
  let response = f.replies.pop();
  assert.equal(response.type, 'config_data'); assert.equal(response.confirmation.saved, true); assert.equal(response.confirmation.executionConfirmed, false);
  assert.equal(response.applicationScope.model, 'hub_new_turn_request'); assert.equal(response.applicationScope.speed, 'saved_only');
  assert.equal(response.applicationScope.desktopFollower, 'execution_owner_settings_unconfirmed'); assert.equal(response.applicationScope.activeTurn, 'unchanged');
  await f.context.handleLegacyClientMessage(ws, { type: 'get_config' });
  assert.equal(f.replies.pop().confirmation.saved, null);
  f.context.fs = { ...fs, writeFileSync() { throw new Error('disk full'); } };
  await f.context.handleLegacyClientMessage(ws, { type: 'update_config', key: 'model', value: 'not-saved' });
  response = f.replies.pop(); assert.equal(response.confirmation.saved, false); assert.equal(response.confirmation.executionConfirmed, false);
  assert.equal(response.data.rawModel, 'fixture-model');
});
