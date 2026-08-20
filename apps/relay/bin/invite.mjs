import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';

function flag(name, fallback = '') {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return fallback;
  return args[idx + 1];
}

const config = loadConfig();
const store = new Store(config.dataDir);
store.load();

if (cmd === 'create') {
  const rec = store.createInvite({
    note: flag('--note'),
    ttlSec: Number(flag('--ttl-sec', String(config.inviteTtlSec))) || 0
  });
  const used = store.activeHubCount();
  const unused = store.listInvites().filter((i) => !i.consumedAt && !i.revokedAt).length;
  if (used + unused > config.maxHubs) {
    console.error(`[invite] warning: ${used} hubs + ${unused} unused invites exceeds RELAY_MAX_HUBS=${config.maxHubs}`);
  }
  console.log(rec.code);
  process.exit(0);
}

if (cmd === 'list') {
  for (const rec of store.listInvites()) {
    const state = rec.revokedAt ? 'revoked' : rec.consumedAt ? `used:${rec.hubId}` : 'unused';
    console.log(`${rec.code}\t${state}\t${rec.note || '-'}`);
  }
  process.exit(0);
}

if (cmd === 'revoke') {
  const code = args[1];
  if (!code) {
    console.error('usage: node bin/invite.mjs revoke <code>');
    process.exit(1);
  }
  store.revokeInvite(code);
  console.log('revoked', code);
  process.exit(0);
}

if (cmd === 'pair-code') {
  const hubId = args[1];
  if (!hubId) {
    console.error('usage: node bin/invite.mjs pair-code <hubId>');
    process.exit(1);
  }
  const rec = store.createPairCode({ hubId, ttlSec: config.pairTtlSec });
  console.log(rec.code);
  process.exit(0);
}

console.log(`OneDesk relay invites

  node bin/invite.mjs create [--note text] [--ttl-sec n]
  node bin/invite.mjs list
  node bin/invite.mjs revoke <code>
  node bin/invite.mjs pair-code <hubId>

Data dir: ${config.dataDir}
`);
