import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createReadStream } from 'fs';
import { realpath, stat, readFile } from 'fs/promises';
import * as path from 'path';
import { operationsHtml } from './operations';

export interface BrowserServerOptions {
  password: string;
  port?: number;
  /** Public HTTPS origin when the loopback gateway is behind a reverse proxy. */
  publicOrigin?: string;
  secureCookie?: boolean;
  /** Public API authenticates its own Bearer keys; browser cookies never grant API rights. */
  publicApi?(req: IncomingMessage, res: ServerResponse): Promise<void>;
  deliveries?(): unknown;
  retryDelivery?(owner: string, id: string): unknown;
  assets: string;
  invoke(channel: string, args: any[]): Promise<any>;
  send(channel: string, args: any[]): void;
  boot(): unknown;
  mediaRoots(): string[];
  resolveMedia(file: string): string;
}

const COOKIE = 'deplao_web_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024 * 1024;
const SEND_CHANNELS = new Set(['app:rendererReady', 'app:uiSettled', 'app:openThread', 'log:append']);
const NATIVE_CHANNELS = /^(window:|shell:|update:)|^file:(openDialog|saveAs|openPath|showItemInFolder|captureScreenshot)$|^db:selectStorageFolder$|^plugins:(pickZip|pickDevFolder|openFolder)$|^cloudflare:workers:/;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('File vượt quá giới hạn 64 MB của request'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function login(res: ServerResponse, error = ''): void {
  res.writeHead(error ? 401 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deplao Web</title>
    <style>body{background:#131518;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:95vh}form{width:min(340px,85vw)}input,button{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #555}button{background:#2563eb;color:white;cursor:pointer}p{color:#bbb}</style>
    <form method="post" action="/api/browser/login"><h1>Deplao Web</h1><p>Đăng nhập bằng mật khẩu web của máy chủ.</p><input name="password" type="password" autocomplete="current-password" placeholder="Mật khẩu" aria-label="Mật khẩu" required autofocus><button>Đăng nhập</button><p role="alert">${error}</p></form></html>`);
}

/** Owner-only, loopback browser gateway. Uses the same workspace and permissions as the desktop owner's UI. */
export async function startBrowserServer(options: BrowserServerOptions) {
  if (!options.password || options.password.length < 12) throw new Error('DEPLAO_WEB_PASSWORD cần ít nhất 12 ký tự');
  const passwordHash = createHash('sha256').update(options.password).digest();
  const sessions = new Map<string, number>();
  const streams = new Map<ServerResponse, string>();
  let attempts = 0;
  let attemptWindow = Date.now();
  let activeCalls = 0;
  let authority = '';

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // same-origin, not no-referrer: with no-referrer browsers send `Origin: null` on the login form POST and the origin check below rejects it (403).
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    // Reject DNS rebinding and cross-origin requests before reading cookies or bodies.
    const allowedOrigins = new Set([`http://${authority}`, options.publicOrigin].filter(Boolean));
    if (req.headers.host !== authority || (req.headers.origin && !allowedOrigins.has(req.headers.origin))) {
      json(res, 403, { error: 'Nguồn truy cập không hợp lệ' });
      return;
    }
    try {
      const url = new URL(req.url || '/', `http://${authority}`);
      if (options.publicApi && (url.pathname.startsWith('/api/v1/') || url.pathname === '/docs' || url.pathname.startsWith('/docs/'))) {
        await options.publicApi(req, res);
        return;
      }
      const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
      const authenticated = (sessions.get(token) || 0) > Date.now();
      if (url.pathname === '/api/browser/login' && req.method === 'POST') {
        if (Date.now() - attemptWindow > 60_000) { attempts = 0; attemptWindow = Date.now(); }
        if (++attempts > 10) { json(res, 429, { error: 'Thử lại sau một phút' }); return; }
        const input = new URLSearchParams(await body(req)).get('password') || '';
        if (!timingSafeEqual(passwordHash, createHash('sha256').update(input).digest())) {
          login(res, 'Mật khẩu không đúng'); return;
        }
        for (const [id, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(id);
        if (sessions.size >= 32) { json(res, 429, { error: 'Quá nhiều phiên đăng nhập' }); return; }
        const id = randomBytes(32).toString('hex');
        sessions.set(id, Date.now() + SESSION_MS);
        const secure = options.secureCookie ? '; Secure' : '';
        res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
        res.end(); return;
      }
      if (!authenticated) {
        if (url.pathname === '/' && req.method === 'GET') login(res);
        else json(res, 401, { error: 'Vui lòng đăng nhập lại' });
        return;
      }
      if (url.pathname === '/api/browser/logout' && req.method === 'POST') {
        sessions.delete(token);
        for (const [stream, owner] of streams) if (owner === token) { stream.end(); streams.delete(stream); }
        const secure = options.secureCookie ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
        json(res, 200, { success: true }); return;
      }
      if (url.pathname === '/operations' && req.method === 'GET') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(operationsHtml); return;
      }
      if (url.pathname === '/api/browser/deliveries' && req.method === 'GET' && options.deliveries) {
        json(res, 200, options.deliveries()); return;
      }
      if (url.pathname === '/api/browser/deliveries/retry' && req.method === 'POST' && options.retryDelivery) {
        const value = JSON.parse(await body(req));
        if (typeof value.owner !== 'string' || typeof value.id !== 'string') { json(res, 400, {error: 'Invalid delivery'}); return; }
        json(res, 200, options.retryDelivery(value.owner, value.id)); return;
      }
      if (url.pathname === '/api/browser/boot' && req.method === 'GET') {
        json(res, 200, { i18n: options.boot() }); return;
      }
      if (url.pathname === '/api/browser/events' && req.method === 'GET') {
        if (streams.size >= 32) { json(res, 429, { error: 'Quá nhiều kết nối' }); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        streams.set(res, token);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (url.pathname === '/api/browser/rpc' && req.method === 'POST') {
        if (activeCalls >= 32) { json(res, 429, { error: 'Máy chủ đang bận' }); return; }
        activeCalls++;
        try {
          const { channel, args = [], send = false } = JSON.parse(await body(req));
          if (typeof channel !== 'string' || !Array.isArray(args)) { json(res, 400, { error: 'Lệnh không hợp lệ' }); return; }
          if (NATIVE_CHANNELS.test(channel) || (send && !SEND_CHANNELS.has(channel))) {
            json(res, 400, { error: 'Chức năng này chỉ có trên desktop' }); return;
          }
          const result = send ? options.send(channel, args) : await options.invoke(channel, args);
          json(res, 200, { result });
        } finally { activeCalls--; }
        return;
      }
      if (url.pathname === '/api/browser/media' && (req.method === 'GET' || req.method === 'HEAD')) {
        const requested = url.searchParams.get('path');
        if (!requested) { json(res, 400, { error: 'Thiếu đường dẫn' }); return; }
        const file = await realpath(options.resolveMedia(requested));
        const roots = await Promise.all(options.mediaRoots().map(root => realpath(root).catch(() => '')));
        if (!roots.some(root => root && within(root, file))) { json(res, 403, { error: 'File ngoài thư mục media' }); return; }
        await serveFile(req, res, file, url.searchParams.get('download')); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'Method không hợp lệ' }); return; }
      if (url.pathname.startsWith('/api/')) { json(res, 404, { error: 'Không tìm thấy API' }); return; }
      const root = await realpath(options.assets);
      const requested = decodeURIComponent(url.pathname);
      const file = await realpath(path.join(root, requested === '/' ? 'index.html' : requested));
      if (!within(root, file)) { json(res, 403, { error: 'Đường dẫn không hợp lệ' }); return; }
      // HTML is never cached: it carries the currently deployed bundle references.
      if (path.extname(file) === '.html') res.setHeader('Cache-Control', 'no-store');
      await serveFile(req, res, file);
    } catch (error: any) {
      if (!res.headersSent) json(res, error.status || (error.code === 'ENOENT' ? 404 : error instanceof SyntaxError ? 400 : 500), { error: error.code === 'ENOENT' ? 'Không tìm thấy file' : error.message });
      else res.destroy();
    }
  });
  server.requestTimeout = 120_000;
  await readFile(path.join(options.assets, 'index.html')); // Fail startup if the browser bundle was not built.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 27800, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  authority = `127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  const heartbeat = setInterval(() => {
    for (const [stream, owner] of streams) {
      if ((sessions.get(owner) || 0) <= Date.now()) { stream.end(); streams.delete(stream); }
      else stream.write(': heartbeat\n\n');
    }
    for (const [id, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(id);
  }, 15_000);
  heartbeat.unref();
  return {
    url: `http://${authority}`,
    publish(channel: string, args: any[]) {
      const payload = `data: ${JSON.stringify({ channel, args })}\n\n`;
      for (const [stream, owner] of streams) {
        if ((sessions.get(owner) || 0) <= Date.now() || stream.writableLength > 1024 * 1024) {
          stream.end(); streams.delete(stream);
        } else stream.write(payload);
      }
    },
    async close() {
      clearInterval(heartbeat);
      for (const stream of streams.keys()) stream.end();
      streams.clear(); sessions.clear();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, download?: string | null): Promise<void> {
  const info = await stat(file);
  if (!info.isFile()) { json(res, 404, { error: 'Không tìm thấy file' }); return; }
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  // Media is untrusted user content, including HTML / SVG files.
  if (file && req.url?.startsWith('/api/browser/media')) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  if (download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(download))}`);
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    }
    if (!match || (!match[1] && !match[2]) || start > end || start >= info.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
    }
    status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  res.setHeader('Content-Length', Math.max(0, end - start + 1));
  res.writeHead(status);
  if (req.method === 'HEAD' || !info.size) { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
