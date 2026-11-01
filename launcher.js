'use strict';
// Node-only launcher for the belmo-node VLESS over WebSocket node.
// No dependencies, Node standard library only.
//
// How it works:
// - Downloads the Xray binary on first start (unless bin/xray exists).
// - Writes an Xray config from environment variables and spawns Xray,
//   which listens for VLESS over WebSocket on 127.0.0.1:10000.
// - Serves HTTP on $PORT itself: GET / answers 200 "ok" (health check),
//   and WebSocket upgrades to WS_PATH are proxied as raw TCP to Xray.
//
// Configuration comes only from environment variables. No secrets here.
// - UUID: the VLESS user id, required.
// - WS_PATH: WebSocket path, default /vless.
// - PORT: the port the platform routes to, default 3000.
// - XRAY_URL: override for the Xray download (default: latest release).
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UUID = process.env.UUID || '';
const WS_PATH = process.env.WS_PATH || '/vless';
const XRAY_URL = process.env.XRAY_URL ||
  'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
const BIN_DIR = path.join(__dirname, 'bin');
const XRAY_BIN = path.join(BIN_DIR, 'xray');
const XRAY_JSON = '/tmp/xray.json';

if (!UUID) {
  console.error('UUID env is required');
  process.exit(1);
}

function fetchToFile(urlString, dest, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlString);
    const lib = urlObj.protocol === 'http:' ? http : https;
    const req = lib.get(urlObj, { headers: { 'User-Agent': 'belmo-node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, urlObj).toString();
        return resolve(fetchToFile(next, dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('download failed, status ' + res.statusCode));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timed out')));
  });
}

// Minimal ZIP extractor: finds the entry named "xray" via the central
// directory and inflates it (stored or deflated). No external tools.
function extractXray(zipPath, outPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP end of central directory not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const total = buf.readUInt16LE(eocd + 10);
  let entry = null;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === 'xray' || name.endsWith('/xray')) {
      entry = { method, compSize, localOff };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entry) throw new Error('xray entry not found in ZIP');
  if (entry.compSize === 0xffffffff) throw new Error('zip64 not supported');
  const lh = entry.localOff;
  if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('bad local header');
  const lhNameLen = buf.readUInt16LE(lh + 26);
  const lhExtraLen = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const comp = buf.subarray(dataStart, dataStart + entry.compSize);
  const raw = entry.method === 0 ? Buffer.from(comp)
    : entry.method === 8 ? zlib.inflateRawSync(comp)
    : (() => { throw new Error('unsupported ZIP method ' + entry.method); })();
  fs.writeFileSync(outPath, raw, { mode: 0o755 });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) return;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zipPath = path.join(BIN_DIR, 'xray.zip');
  console.log('downloading Xray...');
  await fetchToFile(XRAY_URL, zipPath, 10);
  extractXray(zipPath, XRAY_BIN);
  fs.unlinkSync(zipPath);
  console.log('Xray ready');
}

function writeXrayConfig() {
  const config = {
    inbounds: [{
      port: 10000,
      listen: '127.0.0.1',
      protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } },
    }],
    outbounds: [{ protocol: 'freedom' }],
  };
  fs.writeFileSync(XRAY_JSON, JSON.stringify(config));
}

function startXray() {
  const child = spawn(XRAY_BIN, ['run', '-c', XRAY_JSON], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code) => console.error('Xray exited with code ' + code));
}

function startHttp() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const urlPath = (req.url || '').split('?')[0];
    if (urlPath !== WS_PATH) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(10000, '127.0.0.1', () => {
      let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
      for (const [k, v] of Object.entries(req.headers)) raw += k + ': ' + v + '\r\n';
      raw += '\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => { try { socket.destroy(); } catch (e) {} });
    socket.on('error', () => { try { upstream.destroy(); } catch (e) {} });
  });
  server.listen(PORT, () => console.log('listening on ' + PORT));
}

startHttp();
ensureXray().then(() => {
  writeXrayConfig();
  startXray();
}).catch((e) => {
  console.error('startup failed: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
