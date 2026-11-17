import { createClientApi, ClientTransport } from '../../shared/platform/createClientApi';
import { browserMediaUrl } from '../../shared/platform/browserMedia';

type Listener = (...args: any[]) => void;
const listeners = new Map<string, Set<Listener>>();

function adaptMedia(value: any): any {
  if (typeof value === 'string' && /^(local-media:\/\/|media:\/\/local\/)/.test(value)) return browserMediaUrl(value);
  if (Array.isArray(value)) return value.map(adaptMedia);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, adaptMedia(item)]));
  return value;
}

async function rpc(channel: string, args: any[] = [], send = false): Promise<any> {
  const response = await fetch('/api/browser/rpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, args, send }),
  });
  if (response.status === 401) { location.reload(); throw new Error('Phiên đăng nhập đã hết hạn'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Không kết nối được máy chủ');
  return adaptMedia(data.result);
}

function openExternal(url: string) {
  const parsed = new URL(url, location.href);
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) throw new Error('Liên kết không được hỗ trợ');
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}

function download(url: string, name?: string) {
  const link = document.createElement('a');
  link.href = url; link.download = name || ''; link.rel = 'noopener';
  link.target = '_blank'; document.body.appendChild(link); link.click(); link.remove();
}

async function pickFiles(options: any = {}) {
  const files = await new Promise<File[]>(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = !!options.multiSelect;
    const extensions: string[] = options.filters?.flatMap((filter: any) => filter.extensions || []) || [];
    if (!extensions.includes('*')) input.accept = extensions.map(ext => `.${ext}`).join(',');
    input.style.display = 'none'; document.body.appendChild(input);
    const finish = (files: File[]) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => finish(Array.from(input.files || [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    input.click();
  });
  const filePaths: string[] = [];
  for (const file of files) {
    if (file.size > 40 * 1024 * 1024) throw new Error('Mỗi file tải lên tối đa 40 MB');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const result = await rpc('file:saveTempBlob', [{ base64, filename: file.name, ext: file.name.split('.').pop() }]);
    if (!result?.success) throw new Error(result?.error || 'Không tải được file');
    filePaths.push(result.filePath);
  }
  return { success: true, canceled: !filePaths.length, filePaths };
}

const transport: ClientTransport = {
  async invoke(channel, ...args) {
    if (channel === 'window:isMaximized') return false;
    if (channel === 'file:openDialog') return pickFiles(args[0]);
    if (channel === 'shell:openInApp') { openExternal(args[0]); return { success: true }; }
    if (['file:openPath', 'shell:openPath'].includes(channel)) {
      download(browserMediaUrl(args[0], args[0].split(/[\\/]/).pop())); return { success: true };
    }
    if (channel === 'file:saveAs') {
      const { localPath, remoteUrl, defaultName } = args[0] || {};
      if (!localPath) throw new Error('Hãy tải media về máy chủ trước khi lưu từ trình duyệt');
      download(browserMediaUrl(localPath, defaultName)); return { success: true };
    }
    if (channel === 'file:showItemInFolder' || channel === 'file:captureScreenshot') {
      throw new Error('Chức năng này chỉ có trên desktop');
    }
    return rpc(channel, args);
  },
  send(channel, ...args) {
    if (channel === 'shell:openExternal') { openExternal(args[0]); return; }
    if (['app:rendererReady', 'app:uiSettled', 'app:openThread', 'log:append'].includes(channel)) {
      void rpc(channel, args, true).catch(error => console.warn('[web]', error.message));
    }
  },
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(listener);
  },
  removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
  removeAllListeners(channel) { listeners.delete(channel); },
};

async function boot() {
  const response = await fetch('/api/browser/boot');
  if (response.status === 401) { location.reload(); return; }
  if (!response.ok) throw new Error('Không kết nối được backend Deplao');
  const payload = await response.json();
  document.documentElement.dataset.deplaoRuntime = 'web';
  (window as any).deplaoI18n = payload.i18n;
  (window as any).electronAPI = createClientApi(transport, 'web');
  const events = new EventSource('/api/browser/events');
  // Reconnect reloads the workspace snapshot; mutations are never retried automatically.
  let connected = false;
  await new Promise<void>((resolve, reject) => {
    events.onopen = () => {
      if (connected) location.reload();
      connected = true; resolve();
    };
    events.onerror = () => {
      if (!connected) { events.close(); reject(new Error('Không kết nối được luồng sự kiện. Tải lại trang để thử lại.')); }
    };
    events.onmessage = event => {
      const { channel, args } = JSON.parse(event.data);
      for (const listener of listeners.get(channel) || []) {
        try { listener({}, ...adaptMedia(args)); } catch (error) { console.error('[web:event]', error); }
      }
    };
  });
  await import('../main');
}

void boot().catch(error => {
  const root = document.getElementById('root');
  if (root) { root.style.cssText = 'padding:32px;color:#eee;font:16px system-ui'; root.textContent = `Không mở được Deplao Web: ${error.message}`; }
});
