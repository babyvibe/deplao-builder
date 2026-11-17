import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { request as httpRequest } from 'http';
import { startBrowserServer } from '../../../electron/web/BrowserServer';

describe('owner browser gateway', () => {
  let root: string;
  let gateway: Awaited<ReturnType<typeof startBrowserServer>>;
  let cookie: string;
  const invoke = jest.fn(async (channel: string, args: any[]) => ({ channel, args }));
  const send = jest.fn();

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'deplao-web-test-'));
    await mkdir(path.join(root, 'assets'));
    await mkdir(path.join(root, 'media'));
    await writeFile(path.join(root, 'assets/index.html'), '<main>Deplao</main>');
    await writeFile(path.join(root, 'media/video.mp4'), '0123456789');
    await writeFile(path.join(root, 'secret.txt'), 'private');
    await symlink(path.join(root, 'secret.txt'), path.join(root, 'media/escape.txt'));
    gateway = await startBrowserServer({
      password: 'test-password-123', port: 0, assets: path.join(root, 'assets'), invoke, send,
      boot: () => ({ lang: 'vi' }), mediaRoots: () => [path.join(root, 'media')],
      resolveMedia: file => path.isAbsolute(file) ? file : path.join(root, 'media', file),
    });
    const response = await fetch(gateway.url + '/api/browser/login', {
      method: 'POST', body: new URLSearchParams({ password: 'test-password-123' }), redirect: 'manual',
    });
    expect(response.status).toBe(303);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  });
  afterAll(async () => { await gateway?.close(); await rm(root, { recursive: true, force: true }); });

  function request(route: string, init: RequestInit = {}) {
    return fetch(gateway.url + route, { ...init, headers: { Cookie: cookie, ...init.headers } });
  }
  function rpc(value: any, headers = {}) {
    return request('/api/browser/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  }

  test('serves a password form and rejects unauthenticated RPC', async () => {
    expect(await (await fetch(gateway.url)).text()).toContain('type="password"');
    expect((await fetch(gateway.url + '/api/browser/rpc', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  test('does not accept the wrong password', async () => {
    const result = await fetch(gateway.url + '/api/browser/login', { method: 'POST', body: new URLSearchParams({ password: 'wrong' }) });
    expect(result.status).toBe(401);
    expect(result.headers.get('set-cookie')).toBeNull();
  });
  test('serves authenticated assets and language boot payload', async () => {
    expect(await (await request('/')).text()).toContain('<main>Deplao</main>');
    expect(await (await request('/api/browser/boot')).json()).toEqual({ i18n: { lang: 'vi' } });
  });
  test('preserves RPC channel arguments and return values', async () => {
    const args = [{ zaloId: 'account-1', message: 'xin chào' }, 42];
    expect(await (await rpc({ channel: 'zalo:sendMessage', args })).json()).toEqual({ result: { channel: 'zalo:sendMessage', args } });
    expect(invoke).toHaveBeenCalledWith('zalo:sendMessage', args);
  });
  test('rejects cross-origin requests and rebinding host headers', async () => {
    expect((await rpc({ channel: 'db:getAccounts' }, { Origin: 'https://attacker.example' })).status).toBe(403);
    const status = await new Promise<number>(resolve => {
      httpRequest(gateway.url, { headers: { Host: 'attacker.example' } }, res => {
        res.resume(); resolve(res.statusCode!);
      }).end();
    });
    expect(status).toBe(403);
  });
  test('validates RPC bodies and blocks native window commands', async () => {
    expect((await rpc({ channel: 5 })).status).toBe(400);
    expect((await rpc({ channel: 'db:getAccounts', args: {} })).status).toBe(400);
    expect((await rpc({ channel: 'window:quit', send: true })).status).toBe(400);
    expect((await rpc({ channel: 'file:openDialog' })).status).toBe(400);
    expect((await rpc({ channel: 'unlisted:event', send: true })).status).toBe(400);
    expect((await request('/api/browser/rpc', { method: 'POST', body: '{invalid' })).status).toBe(400);
  });
  test('forwards renderer readiness through the explicit send allowlist', async () => {
    expect((await rpc({ channel: 'app:rendererReady', args: [], send: true })).status).toBe(200);
    expect(send).toHaveBeenCalledWith('app:rendererReady', []);
  });
  test('supports video byte ranges including suffix and invalid ranges', async () => {
    const response = await request('/api/browser/media?path=video.mp4', { headers: { Range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('2345');
    expect(await (await request('/api/browser/media?path=video.mp4', { headers: { Range: 'bytes=-3' } })).text()).toBe('789');
    expect((await request('/api/browser/media?path=video.mp4', { headers: { Range: 'bytes=100-' } })).status).toBe(416);
    expect((await request('/api/browser/media?path=video.mp4', { method: 'HEAD' })).headers.get('content-length')).toBe('10');
  });
  test('rejects media traversal, symlink escapes and asset traversal', async () => {
    expect((await request('/api/browser/media?path=../secret.txt')).status).toBe(403);
    expect((await request('/api/browser/media?path=escape.txt')).status).toBe(403);
    expect((await request('/%2e%2e%2fsecret.txt')).status).toBe(403);
  });
  test('streams events, then revokes both RPC and event stream on logout', async () => {
    const controller = new AbortController();
    const response = await request('/api/browser/events', { signal: controller.signal });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    await reader.read(); // initial connected comment
    gateway.publish('event:message', [{ text: 'hello' }]);
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain('"channel":"event:message"');
    expect(event).toContain('"text":"hello"');
    expect((await request('/api/browser/logout', { method: 'POST' })).status).toBe(200);
    expect((await reader.read()).done).toBe(true);
    controller.abort();
    expect((await rpc({ channel: 'login:getAccounts' })).status).toBe(401);
  });
});
