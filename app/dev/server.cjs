// Development server: serves the renderer over HTTP and exposes the same back-end handlers,
// so the UI can be tested in a normal browser without Electron. Not used by the packaged app.
const http = require('http');
const fs = require('fs');
const path = require('path');
const handlers = require('../main/handlers');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 5178);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

handlers.configure({ userData: path.join(ROOT, '.devdata'), onProgress: (p) => { events.push(p); if (events.length > 200) events.shift(); } });
const events = [];

const encode = (v) => {
  if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = encode(v[k]); return o; }
  return v;
};
const decode = (v) => {
  if (v && typeof v === 'object' && v.__b64 !== undefined) return new Uint8Array(Buffer.from(v.__b64, 'base64'));
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = decode(v[k]); return o; }
  return v;
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        if (name === 'events') { res.end(JSON.stringify(events.splice(0))); return; }
        const fn = handlers[name];
        if (!fn || name === 'configure') throw new Error('unknown api ' + name);
        const out = await fn(decode(JSON.parse(body || '{}')));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, value: encode(out) }));
      } catch (e) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (url.pathname.startsWith('/file/')) {
    // local file passthrough for <img> thumbnails in dev mode
    const p = decodeURIComponent(url.pathname.slice(6));
    fs.createReadStream(p).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
    return;
  }
  let p = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
  if (url.pathname === '/') p = path.join(ROOT, 'renderer', 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('content-type', TYPES[path.extname(p)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(data);
  });
}).listen(PORT, () => console.log(`HF Item Studio dev server on http://localhost:${PORT}/`));
