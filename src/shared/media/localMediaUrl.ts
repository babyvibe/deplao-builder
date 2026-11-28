/**
 * local-media:// URLs: Deplao's own scheme for files on this machine (protocol handler in electron/main.ts).
 *
 * Deplao writes them in "slash form": the file path right after "local-media://", not percent-encoded.
 *   local-media:///D:/data/media/123/a.mp4     (Windows drive)
 *   local-media:///media/123/a.jpg             (relative to the data folder)
 *   local-media:///Users/me/data/a.jpg         (macOS / Linux)
 * Stored values (avatars, links in messages, local_paths) keep that form.
 *
 * The scheme is registered as standard: over a non-standard custom scheme Chromium does not read a media file from the
 * middle reliably, so seeking in a video failed. Chromium rewrites a standard URL into "host form" before the handler
 * sees it (and `img.src` / `video.currentSrc` return it): the first path segment becomes the host, in lower case, a
 * drive letter loses its colon, and the rest of the path is percent-encoded.
 *   local-media://d/data/media/123/a.mp4, local-media://media/123/a.jpg, local-media://users/me/data/a.jpg
 * Every reader has to accept both forms: use localMediaUrlToPath instead of stripping the prefix by hand.
 */

const LOCAL_MEDIA_RE = /^local-media:/i;
const HOST_FORM_RE = /^\/\/[^/]/;
const DRIVE_HOST_RE = /^([a-z]):?$/i;
const DRIVE_PATH_RE = /^\/([a-z]):(?=\/|$)/i;

export function isLocalMediaUrl(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_MEDIA_RE.test(value);
}

/**
 * Slash-form URL with every folder / file name percent-encoded (a "#" or "%" in a name survives), except a drive
 * letter: Chromium makes the first segment the host of a standard URL, and an encoded "D%3A" there is invalid.
 */
export function encodedLocalMediaUrl(filePath: string): string {
  const normalized = String(filePath).replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const segments = withSlash.split('/').map((segment, index) => (index === 1 && /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment)));
  return `local-media://${segments.join('/')}`;
}

/** Decodes each run of %XX escapes on its own, so a literal "%" in a file name ("Giảm 10%.xls") stays as it is. */
function decodeEscapes(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * The file path inside a local-media URL, with "/" separators. Query ("?cw=long", "?t=…") and fragment are dropped.
 *
 * - Windows (`windows: true`): "D:/…" for a drive; a path relative to the data folder comes back without its leading
 *   slash ("media/123/a.jpg"), as the protocol handler always treated it.
 * - Other systems: "/…". A relative "media/…" path also comes back as "/media/…": callers fall back to the part after
 *   "/media/" when that file does not exist, as before. In host form the first folder is lower case ("/users/…"), so
 *   on a case-sensitive disk the caller has to match it with the real folder name.
 *
 * Only the host form is percent-decoded: the slash form is written by Deplao without encoding.
 * Returns '' when the value is not a local-media URL.
 */
export function localMediaUrlToPath(url: string, opts: { windows: boolean }): string {
  if (!isLocalMediaUrl(url)) return '';
  const rest = url.replace(LOCAL_MEDIA_RE, '');
  let filePath: string;
  if (HOST_FORM_RE.test(rest)) {
    const end = rest.search(/[?#]/);
    const body = end >= 0 ? rest.slice(2, end) : rest.slice(2);
    const slash = body.indexOf('/');
    const host = slash >= 0 ? body.slice(0, slash) : body;
    const tail = decodeEscapes(slash >= 0 ? body.slice(slash) : '');
    const drive = DRIVE_HOST_RE.exec(host);
    if (opts.windows && drive) return `${drive[1].toUpperCase()}:${tail || '/'}`;
    filePath = `/${decodeEscapes(host)}${tail}`;
  } else {
    // Slash form: a Windows file name cannot contain "?", so the first "?" starts Deplao's own query
    const end = rest.indexOf('?');
    filePath = '/' + (end >= 0 ? rest.slice(0, end) : rest).replace(/^\/+/, '');
  }
  filePath = filePath.replace(/\\/g, '/');
  if (!opts.windows) return filePath;
  const drive = DRIVE_PATH_RE.exec(filePath);
  if (drive) return `${drive[1].toUpperCase()}:${filePath.slice(3) || '/'}`;
  return filePath.replace(/^\/+/, '');
}
