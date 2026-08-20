import fs from 'fs';
import path from 'path';
import { nowIso } from './util.js';

export class Audit {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(event, fields = {}) {
    const row = {
      ts: nowIso(),
      event,
      hubId: fields.hubId || undefined,
      deviceId: fields.deviceId || undefined,
      ip: fields.ip || undefined
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`);
  }
}
