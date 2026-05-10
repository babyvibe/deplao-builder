/**
 * Convert absolute local file path → local-media:// URL
 * which is served by Electron's custom protocol handler (bypasses CSP/sandbox restriction on file://).
 *
 * Usage:
 *   <img src={toLocalMediaUrl(filePath)} />
 *   // e.g. local-media:///D:/path/to/img.jpg
 */
export function toLocalMediaUrl(filePath: string): string {
  if (!filePath) return '';
  // Already a proper URL → return as-is
  if (filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith('local-media://')) {
    return filePath;
  }
  // Strip existing file:/// prefix if present
  const stripped = filePath.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
  // Normalize backslashes → forward slashes
  const normalized = stripped.replace(/\\/g, '/');
  // Ensure leading slash for absolute paths on Windows (D:/... → /D:/...)
  const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return 'local-media://' + withSlash;
}

/**
 * Check if a path is a local file path (not a remote URL)
 */
export function isLocalPath(path: string): boolean {
  if (!path) return false;
  return !path.startsWith('http://') && !path.startsWith('https://') && !path.startsWith('data:');
}

