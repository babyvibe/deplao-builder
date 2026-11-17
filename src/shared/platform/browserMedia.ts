/** HTTP counterpart of Electron's local-media protocol. */
export function browserMediaUrl(value: string, download?: string): string {
  if (value.startsWith('/api/browser/media?')) {
    const url = new URL(value, 'http://browser.local');
    if (download) url.searchParams.set('download', download);
    return url.pathname + url.search;
  }
  let file = value;
  if (/^(local-media|file):\/\//.test(file)) {
    const url = new URL(file);
    file = decodeURIComponent(url.pathname);
    // Windows protocol URLs include an extra slash before the drive letter.
    if (/^\/[a-z]:\//i.test(file)) file = file.slice(1);
  } else file = file.replace(/^media:\/\/local\//, '').replace(/^file:\/\//, '');
  return `/api/browser/media?path=${encodeURIComponent(file)}${download ? `&download=${encodeURIComponent(download)}` : ''}`;
}
