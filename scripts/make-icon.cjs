// Renders build/icon.png (512x512) from an inline SVG using Electron's offscreen rendering.
// Usage: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2140"/><stop offset="1" stop-color="#0d0f1a"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b8cff"/><stop offset="0.55" stop-color="#8a5bff"/><stop offset="1" stop-color="#d36bff"/>
    </linearGradient>
    <linearGradient id="line" gradientUnits="userSpaceOnUse" x1="196" y1="110" x2="330" y2="400">
      <stop offset="0" stop-color="#7aa2ff"/><stop offset="0.6" stop-color="#9a6bff"/><stop offset="1" stop-color="#d36bff"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="#8a5bff" stop-opacity="0.45"/><stop offset="1" stop-color="#8a5bff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#glow)"/>
  <rect x="17.5" y="17.5" width="477" height="477" rx="110.5" fill="none" stroke="url(#ring)" stroke-width="3" opacity="0.7"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M196 120 V392" stroke="url(#line)" stroke-width="30"/>
    <path d="M196 300 C196 236 316 250 316 186" stroke="url(#line)" stroke-width="30"/>
  </g>
  <circle cx="196" cy="120" r="30" fill="#ffffff"/>
  <circle cx="196" cy="392" r="30" fill="#ffffff"/>
  <circle cx="316" cy="166" r="40" fill="#3ecf8e"/>
  <path d="M298 166 l12 12 l22 -24" fill="none" stroke="#0d0f1a" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const png = image.resize({ width: 512, height: 512 }).toPNG();
  fs.writeFileSync(out, png);
  // The same mark is used inside the app (header, footer, About).
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assets', 'logo.png'), png);
  console.log('wrote', out);
  app.quit();
});
