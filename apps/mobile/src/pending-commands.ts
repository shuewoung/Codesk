// Deliberately excludes prompt text, attachment paths and credentials.
export type PendingCommand = { namespace: string; requestId: string; clientUserMessageId: string; threadId: string; createdAt: number };

export function pendingCommand(value: unknown): PendingCommand {
  const row = value as PendingCommand;
  if (!row || ![row.namespace, row.requestId, row.clientUserMessageId, row.threadId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 1024) || !Number.isFinite(row.createdAt)) throw new Error('Pending command record invalid');
  return { namespace: row.namespace, requestId: row.requestId, clientUserMessageId: row.clientUserMessageId, threadId: row.threadId, createdAt: row.createdAt };
}

export function createPendingCommandStorage(readRaw: () => Promise<string | null>, writeRaw: (raw: string) => Promise<void>) {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>) {
    const result = tail.then(fn); tail = result.catch(() => undefined); return result;
  }
  async function read(): Promise<PendingCommand[]> {
    const raw = await readRaw();
    const rows: unknown = raw == null ? [] : JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('Pending command storage invalid');
    return rows.map(pendingCommand);
  }
  return {
    load: (namespace: string) => serial(async () => (await read()).filter(row => row.namespace === namespace)),
    put: (value: PendingCommand) => serial(async () => {
      const row = pendingCommand(value); const rows = await read();
      const current = rows.find(r => r.namespace === row.namespace && r.requestId === row.requestId);
      if (current && (current.threadId !== row.threadId || current.clientUserMessageId !== row.clientUserMessageId)) throw new Error('Pending command identity conflict');
      if (!current) {
        if (rows.length >= 200) throw new Error('Pending command storage full; resolve older requests first');
        rows.push(row);
      }
      await writeRaw(JSON.stringify(rows));
    }),
    remove: (namespace: string, requestId: string) => serial(async () => {
      await writeRaw(JSON.stringify((await read()).filter(row => row.namespace !== namespace || row.requestId !== requestId)));
    }),
  };
}
