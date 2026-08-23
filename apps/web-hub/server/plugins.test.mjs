import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePluginId,
  parsePluginSections,
  setPluginEnabledInToml,
} from './plugins.js';
import { parseGitFiles } from './local-cmd.js';

test('parsePluginId splits marketplace', () => {
  assert.deepEqual(parsePluginId('chrome@openai-bundled'), {
    id: 'chrome@openai-bundled',
    name: 'chrome',
    marketplace: 'openai-bundled',
  });
});

test('parsePluginSections reads enabled flags', () => {
  const toml = `
model = "x"
[plugins."chrome@openai-bundled"]
enabled = true
[plugins."gmail@openai-curated-remote"]
enabled = false
`;
  const rows = parsePluginSections(toml);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[1].id, 'gmail@openai-curated-remote');
  assert.equal(rows[1].enabled, false);
});

test('setPluginEnabledInToml flips existing and appends missing', () => {
  const toml = `[plugins."chrome@openai-bundled"]\nenabled = true\n`;
  const off = setPluginEnabledInToml(toml, 'chrome@openai-bundled', false);
  assert.match(off, /enabled = false/);
  const added = setPluginEnabledInToml(off, 'sites@openai-bundled', true);
  assert.match(added, /\[plugins\."sites@openai-bundled"\]/);
  assert.match(added, /enabled = true/);
});

test('parseGitFiles merges status and diff', () => {
  const files = parseGitFiles(' M src/a.ts\n?? src/b.ts\n', 'diff --git a/src/a.ts b/src/a.ts\n+ok\n-old\n');
  assert.deepEqual(files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts']);
  const a = files.find((f) => f.path === 'src/a.ts');
  assert.equal(a.add, 1);
  assert.equal(a.del, 1);
});
