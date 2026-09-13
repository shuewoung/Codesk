import fs from 'node:fs';
import path from 'node:path';
import { decodeRequestedPath } from './file-raw.js';

export function withinRoot(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// roots MUST come from server session metadata, never request.cwd.
export function createFileAccess({ roots = [], uploadDir = '', cwd = '', deniedRoots = [], generatedImageRoot = '' } = {}) {
  const realRoots = [...roots, uploadDir].filter(Boolean).flatMap((root) => {
    try { return [fs.realpathSync(root)]; } catch { return []; }
  });
  const authorize = (raw, base = cwd) => {
    const decoded = decodeRequestedPath(raw);
    if (!decoded || (!path.isAbsolute(decoded) && !base)) throw new Error('缺少已授权工作目录');
    const lexical = path.resolve(base || '.', decoded);
    // A narrow file-only exception, never a CODEX_HOME directory grant.
    if (generatedImageRoot && withinRoot(path.resolve(generatedImageRoot), lexical)) {
      const root = path.resolve(generatedImageRoot);
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(lexical);
      // Reject redirected root directories as well as escaping file symlinks.
      if (realRoot !== root || !withinRoot(root, real) || !fs.statSync(real).isFile()
        || !/\.(png|jpe?g|webp|gif)$/i.test(lexical) || !/\.(png|jpe?g|webp|gif)$/i.test(real)) throw new Error('生成图片路径无效');
      return real;
    }
    // Check both names: a symlink cannot authorize an external spelling either.
    if (![...roots, uploadDir].filter(Boolean).some((root) => withinRoot(path.resolve(root), lexical))) throw new Error('文件路径不在已授权工作目录内');
    const real = fs.realpathSync(lexical);
    const stat = fs.statSync(real);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('只允许普通文件或目录');
    if (!realRoots.some((root) => withinRoot(root, real))) throw new Error('文件链接越过授权目录');
    const inUpload = uploadDir && withinRoot(path.resolve(uploadDir), lexical) && withinRoot(fs.realpathSync(uploadDir), real);
    if (!inUpload && deniedRoots.some((root) => {
      let realRoot = path.resolve(root);
      try { realRoot = fs.realpathSync(root); } catch {}
      return withinRoot(path.resolve(root), lexical) || withinRoot(realRoot, real);
    })) throw new Error('不能读取 Hub 私有数据');
    return real;
  };
  return { authorize, allows(raw) { try { authorize(raw); return true; } catch { return false; } } };
}

export function correlationFields(msg = {}, upload = false) {
  const fields = {};
  for (const key of upload ? ['requestId', 'taskId', 'threadId'] : ['requestId']) {
    if (typeof msg[key] === 'string' || typeof msg[key] === 'number') fields[key] = msg[key];
  }
  return fields;
}

// Read a bounded snapshot from one descriptor; never allocate from an unbounded
// readFile after a size check. Recheck authorization and descriptor identity.
export function readBoundedFile(filePath, limit, access, callback) {
  let fd, result, error;
  try {
    const real = access.authorize(filePath);
    fd = fs.openSync(real, 'r');
    const before = fs.fstatSync(fd);
    const current = fs.statSync(access.authorize(real));
    if (!before.isFile() || before.ino !== current.ino || before.dev !== current.dev) throw new Error('文件发生变化');
    if (before.size > limit) throw new Error('文件超过 20MB');
    result = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < result.length) {
      const count = fs.readSync(fd, result, offset, result.length - offset, offset);
      if (!count) throw new Error('文件发生变化');
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('文件发生变化');
  } catch (e) { error = e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  callback(error, result);
}

export function fileMetadata(filePath, source) {
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error('不是普通文件');
  return { path: filePath, name: path.basename(filePath), ext: path.extname(filePath).toLowerCase(), size: st.size, mtimeMs: st.mtimeMs, source };
}
