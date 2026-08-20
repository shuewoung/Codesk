import fs from 'fs';
import path from 'path';
import QRCode from '../../mobile/node_modules/qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from '../../mobile/node_modules/qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

const url = 'https://codesk.icu/codesk-latest.apk';
const qr = new QRCode(-1, QRErrorCorrectLevel.M);
qr.addData(url);
qr.make();

const count = qr.getModuleCount();
const cellSize = 8;
const margin = 16;
const size = count * cellSize + margin * 2;

let paths = '';
for (let r = 0; r < count; r++) {
  for (let c = 0; c < count; c++) {
    if (qr.isDark(r, c)) {
      const x = margin + c * cellSize;
      const y = margin + r * cellSize;
      paths += `M${x},${y}h${cellSize}v${cellSize}h-${cellSize}z `;
    }
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="100%" height="100%" fill="#ffffff" rx="12"/>
  <path d="${paths}" fill="#12141a"/>
</svg>`;

const outPath = path.resolve('public/apk-qr.svg');
fs.writeFileSync(outPath, svg, 'utf-8');
console.log('Successfully generated', outPath);
