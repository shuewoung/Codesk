import fs from 'node:fs';
import path from 'node:path';

const DESKTOP_UI = new Set(['browser', 'chrome', 'computer-use', 'sites', 'visualize']);

export function parsePluginId(id) {
  const raw = String(id || '').trim();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return { id: raw, name: raw, marketplace: '' };
  return { id: raw, name: raw.slice(0, at), marketplace: raw.slice(at + 1) };
}

export function parsePluginSections(toml) {
  const text = String(toml || '');
  const out = [];
  const re = /^\[plugins\."([^"]+)"\][ \t]*$/gm;
  let match;
  while ((match = re.exec(text))) {
    const id = match[1];
    const start = match.index + match[0].length;
    const rest = text.slice(start);
    const next = rest.search(/\n\[/);
    const body = next < 0 ? rest : rest.slice(0, next);
    const enabledMatch = /(?:^|\n)[ \t]*enabled[ \t]*=[ \t]*(true|false)/i.exec(body);
    out.push({
      id,
      enabled: !enabledMatch || enabledMatch[1].toLowerCase() === 'true',
    });
  }
  return out;
}

export function setPluginEnabledInToml(toml, id, enabled) {
  const text = String(toml || '');
  const want = String(id || '').trim();
  if (!want) return text;
  const flag = enabled ? 'true' : 'false';
  const header = `[plugins."${want}"]`;
  const re = new RegExp(`^\\[plugins\\."${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\][ \\t]*$`, 'm');
  const found = re.exec(text);
  if (!found) {
    const block = `\n${header}\nenabled = ${flag}\n`;
    return text.endsWith('\n') || !text ? `${text}${block}` : `${text}\n${block}`;
  }
  const start = found.index + found[0].length;
  const rest = text.slice(start);
  const next = rest.search(/\n\[/);
  const body = next < 0 ? rest : rest.slice(0, next);
  const tail = next < 0 ? '' : rest.slice(next);
  let nextBody = body;
  if (/(?:^|\n)[ \t]*enabled[ \t]*=/i.test(body)) {
    nextBody = body.replace(/(^|\n)([ \t]*enabled[ \t]*=[ \t]*)(true|false)/i, `$1$2${flag}`);
  } else {
    nextBody = `\nenabled = ${flag}${body.startsWith('\n') ? '' : '\n'}${body}`;
  }
  return `${text.slice(0, start)}${nextBody}${tail}`;
}

function latestDir(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let best = null;
  let bestMs = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (!st.isDirectory()) continue;
      if (st.mtimeMs >= bestMs) {
        best = full;
        bestMs = st.mtimeMs;
      }
    } catch {
      /* skip */
    }
  }
  return best;
}

export function readPluginMeta(codexHome, id) {
  const parsed = parsePluginId(id);
  const cacheRoot = path.join(codexHome, 'plugins', 'cache', parsed.marketplace || '', parsed.name);
  const versionDir = latestDir(cacheRoot);
  const jsonPath = versionDir ? path.join(versionDir, '.codex-plugin', 'plugin.json') : '';
  let meta = {};
  if (jsonPath && fs.existsSync(jsonPath)) {
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) || {}; } catch { meta = {}; }
  }
  const iface = meta.interface && typeof meta.interface === 'object' ? meta.interface : {};
  return {
    displayName: String(iface.displayName || meta.name || parsed.name),
    description: String(iface.shortDescription || meta.description || '').split('\n')[0].slice(0, 180),
    category: String(iface.category || ''),
    version: String(meta.version || path.basename(versionDir || '')),
  };
}

export function createPluginStore(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');

  function readToml() {
    try {
      return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    } catch {
      return '';
    }
  }

  function list() {
    return parsePluginSections(readToml()).map((row) => {
      const parsed = parsePluginId(row.id);
      const meta = readPluginMeta(codexHome, row.id);
      return {
        id: row.id,
        name: parsed.name,
        marketplace: parsed.marketplace,
        enabled: row.enabled,
        displayName: meta.displayName,
        description: meta.description,
        category: meta.category,
        version: meta.version,
        needsDesktopUi: DESKTOP_UI.has(parsed.name),
        mention: `@${parsed.name}`,
      };
    });
  }

  function setEnabled(id, enabled) {
    const next = setPluginEnabledInToml(readToml(), id, enabled);
    fs.writeFileSync(configPath, next, 'utf8');
    return list();
  }

  return { list, setEnabled };
}
