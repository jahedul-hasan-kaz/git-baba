// Renders build/icon.png (512x512) from an inline SVG using Electron's offscreen rendering.
// Usage: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#8a5bff"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="url(#bg)"/>
  <path d="M256 92 L392 140 V246 C392 330 334 392 256 424 C178 392 120 330 120 246 V140 Z" fill="#0f1115" opacity="0.92"/>
  <g stroke="#ffffff" stroke-width="22" stroke-linecap="round" fill="none">
    <line x1="210" y1="190" x2="210" y2="330"/>
    <path d="M210 260 C210 230 302 240 302 200"/>
  </g>
  <circle cx="210" cy="180" r="24" fill="#ffffff"/>
  <circle cx="210" cy="338" r="24" fill="#ffffff"/>
  <circle cx="302" cy="190" r="24" fill="#3ecf8e"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.resize({ width: 512, height: 512 }).toPNG());
  console.log('wrote', out);
  app.quit();
});
