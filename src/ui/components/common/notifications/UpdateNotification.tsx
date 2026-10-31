import { useEffect, useRef, useCallback, useState } from 'react';
import DOMPurify from 'dompurify';
import { useAppStore } from '@/store/app/appStore';
import { useUpdateStore, UpdateInfo, ProgressInfo, UpdateError } from '@/store/app/updateStore';

const DOWNLOAD_STALL_TIMEOUT_MS = 45_000;
const APP_VERSION: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?';

/** Fetch aggregated release notes from GitHub for all versions between current and target */
async function fetchAggregatedNotes(currentVersion: string, targetVersion: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/babyvibe/deplao-builder/releases?per_page=30`);
    if (!res.ok) return '';
    const releases: any[] = await res.json();

    // Collect releases newer than current version, up to target
    const notes: string[] = [];
    for (const r of releases) {
      const v = (r.tag_name || '').replace(/^v/, '');
      if (!v) continue;
      // Include if v > currentVersion and v <= targetVersion
      if (compareVersions(v, currentVersion) > 0 && compareVersions(v, targetVersion) <= 0) {
        const body = (r.body || '').trim();
        notes.push(`<h2>v${v}</h2>\n${body ? mdToHtml(body) : '<em>Không có ghi chú</em>'}`);
      }
    }
    return notes.length > 0 ? notes.join('\n<hr/>\n') : '';
  } catch {
    return '';
  }
}

/** Minimal markdown → HTML (headers, lists, bold, italic, links, code) */
function mdToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hulop]|<em|<str|<hr)(.+)$/gm, '<p>$1</p>');
}

/** Simple semver compare: returns 1 if a > b, -1 if a < b, 0 if equal */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export function UpdateNotification() {
  const {
    status, updateInfo, progress, error, showPopup, platform,
    setStatus, setUpdateInfo, setProgress, setError, setShowPopup, startDownload, installUpdate, dismiss,
  } = useUpdateStore();

  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLight = useAppStore(s => s.theme) === 'light';
  const isMac = platform === 'darwin';
  const [aggregatedNotes, setAggregatedNotes] = useState('');
  const [notesLoading, setNotesLoading] = useState(false);

  // Fetch aggregated release notes when update info arrives
  useEffect(() => {
    if (!updateInfo || !showPopup) return;
    // If we already have releaseNotes from electron-updater, use that
    // Otherwise fetch from GitHub for all skipped versions
    if (updateInfo.releaseNotes) {
      // releaseNotes có thể là string hoặc array (electron-updater)
      const notes = Array.isArray(updateInfo.releaseNotes)
        ? updateInfo.releaseNotes.map((n: any) => n.note || n).join('\n')
        : updateInfo.releaseNotes;
      setAggregatedNotes(typeof notes === 'string' ? notes : String(notes));
      return;
    }
    setNotesLoading(true);
    fetchAggregatedNotes(APP_VERSION, updateInfo.version)
      .then(notes => setAggregatedNotes(notes))
      .finally(() => setNotesLoading(false));
  }, [updateInfo, showPopup]);

  const resetStallTimer = useCallback(() => {
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    stallTimerRef.current = setTimeout(() => {
      setError({ message: 'Tải bị gián đoạn', platform });
    }, DOWNLOAD_STALL_TIMEOUT_MS);
  }, [setError, platform]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.on) return;

    // Báo cho main process biết renderer đã sẵn sàng nhận update events
    try { api.update?.rendererReady?.(); } catch {}

    const offAvailable = api.on('update:available', (info: UpdateInfo) => {
      setUpdateInfo(info);
      setStatus('available');
      setError(null);
      // Tự hiện popup thông báo có bản mới (giống như click nút TopBar)
      setShowPopup(true);
    });

    const offProgress = api.on('update:progress', (p: ProgressInfo) => {
      setStatus('downloading');
      setProgress(p);
      resetStallTimer();
    });

    const offDownloaded = api.on('update:downloaded', (info: UpdateInfo) => {
      setStatus('downloaded');
      setUpdateInfo(info);
      setError(null);
      setProgress(null);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    });

    const offNotAvailable = api.on('update:not-available', () => {});

    const offError = api.on('update:error', (err: UpdateError) => {
      setError(err);
      setStatus('error');
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    });

    return () => {
      offAvailable?.();
      offProgress?.();
      offDownloaded?.();
      offNotAvailable?.();
      offError?.();
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    };
  }, [resetStallTimer, setStatus, setUpdateInfo, setProgress, setError]);

  if (!showPopup || !updateInfo) return null;

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const handleConfirmDownload = () => {
    if (isMac) return;
    startDownload();
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => { if (status !== 'downloading') dismiss(); }}>
      <style>{`
        .release-notes h1, .release-notes h2, .release-notes h3 { font-weight: 700; margin: 0.5em 0 0.25em; }
        .release-notes h1 { font-size: 1.1em; }
        .release-notes h2 { font-size: 1em; }
        .release-notes h3 { font-size: 0.95em; }
        .release-notes ul, .release-notes ol { padding-left: 1.2em; margin: 0.25em 0; }
        .release-notes li { margin: 0.15em 0; }
        .release-notes a { color: #60a5fa; text-decoration: underline; }
        .release-notes a:hover { color: #93bbfc; }
        .release-notes p { margin: 0.25em 0; }
        .release-notes code { background: rgba(255,255,255,0.1); padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.95em; }
        .release-notes hr { border: none; border-top: 1px solid rgba(255,255,255,0.15); margin: 0.75em 0; }
      `}</style>
      <div className={`w-[420px] rounded-2xl shadow-2xl p-6 ${isLight ? 'bg-white border border-gray-200 text-gray-800' : 'bg-card border border-input text-foreground'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              Bản cập nhật mới
            </h3>
            <p className={`text-sm mt-0.5 ${isLight ? 'text-subtle-foreground' : 'text-muted-foreground'}`}>Phiên bản {APP_VERSION} → <span className="font-semibold text-foreground">{updateInfo.version}</span></p>
          </div>
          {status !== 'downloading' && (
            <button onClick={dismiss} className={`w-7 h-7 flex items-center justify-center rounded-full transition-colors ${isLight ? 'text-muted-foreground hover:bg-gray-100' : 'text-muted-foreground hover:bg-muted'}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>

        {/* Release notes - aggregated across skipped versions */}
        {notesLoading ? (
          <div className={`mb-4 p-3 rounded-xl text-xs ${isLight ? 'bg-gray-50 text-muted-foreground' : 'bg-card text-muted-foreground'}`}>
            <span className="animate-pulse">Đang tải danh sách thay đổi...</span>
          </div>
        ) : aggregatedNotes ? (
          <div className={`release-notes mb-4 p-3 rounded-xl text-xs leading-relaxed max-h-48 overflow-y-auto ${isLight ? 'bg-gray-50 text-subtle-foreground' : 'bg-card text-foreground/80'}`}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(aggregatedNotes) }} />
        ) : null}

        {status === 'available' && !error && (
          <>
            {isMac ? (
              <div className="space-y-3">
                <p className={`text-xs ${isLight ? 'text-subtle-foreground' : 'text-muted-foreground'}`}>
                  macOS không hỗ trợ cập nhật tự động. Vui lòng tải bản mới nhất về cài đặt:
                </p>
                <div className="flex gap-2">
                  <a href={`https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-${updateInfo.version}-arm64.dmg`} target="_blank" rel="noopener noreferrer" onClick={dismiss}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors no-underline">
                    Apple Silicon (M)
                  </a>
                  <a href={`https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-${updateInfo.version}.dmg`} target="_blank" rel="noopener noreferrer" onClick={dismiss}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-accent hover:bg-accent text-foreground text-sm font-medium transition-colors no-underline">
                    Intel Mac
                  </a>
                </div>
                <button onClick={() => { startDownload(); }}
                  className={`w-full py-2 rounded-xl text-xs transition-colors ${isLight ? 'bg-gray-100 hover:bg-gray-200 text-subtle-foreground' : 'bg-muted hover:bg-accent text-foreground/80'}`}>
                  Thử cập nhật tự động (có thể không hoạt động)
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className={`text-xs ${isLight ? 'text-subtle-foreground' : 'text-muted-foreground'}`}>
                  Nhấn "Cập nhật ngay" để tải và cài đặt bản mới. Ứng dụng sẽ khởi động lại sau khi cài xong.
                </p>
                <div className="flex gap-2">
                  <button onClick={dismiss}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${isLight ? 'bg-gray-100 hover:bg-gray-200 text-subtle-foreground' : 'bg-muted hover:bg-accent text-foreground/80'}`}>
                    Để sau
                  </button>
                  <button onClick={handleConfirmDownload}
                    className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors">
                    Cập nhật ngay
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {status === 'downloading' && (
          <div className="space-y-3">
            <div className="flex justify-between text-xs">
              <span className={isLight ? 'text-subtle-foreground' : 'text-muted-foreground'}>Đang tải...</span>
              <span className="text-blue-400 font-medium">{progress?.percent ?? 0}%</span>
            </div>
            <div className={`h-2 rounded-full overflow-hidden ${isLight ? 'bg-gray-200' : 'bg-muted'}`}>
              <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            {progress && (
              <div className={`flex justify-between text-xs ${isLight ? 'text-muted-foreground' : 'text-subtle-foreground'}`}>
                <span>{formatBytes(progress.transferred)} / {formatBytes(progress.total)}</span>
                <span>{formatBytes(progress.bytesPerSecond)}/s</span>
              </div>
            )}
          </div>
        )}

        {status === 'downloaded' && (
          <div className="space-y-3">
            <p className={`text-sm ${isLight ? 'text-green-600' : 'text-green-400'}`}>
              Đã tải xong! Nhấn "Khởi động lại" để cài đặt.
            </p>
            <button onClick={installUpdate}
              className="w-full py-2.5 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors">
              Khởi động lại & cài đặt
            </button>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-3">
            <p className={`text-xs ${isLight ? 'text-red-500' : 'text-red-400'}`}>
              {error?.message || 'Không thể tải bản cập nhật'}
            </p>
            <div className="flex gap-2">
              <button onClick={() => { setStatus('available'); setError(null); }}
                className={`flex-1 py-2 rounded-xl text-xs font-medium transition-colors ${isLight ? 'bg-gray-100 hover:bg-gray-200 text-subtle-foreground' : 'bg-muted hover:bg-accent text-foreground/80'}`}>
                Thử lại
              </button>
              {isMac ? (
                <div className="flex-1 flex gap-1">
                  <a href={`https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-${updateInfo.version}-arm64.dmg`} target="_blank" rel="noopener noreferrer" onClick={dismiss}
                    className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium text-center no-underline">ARM (chip M+)</a>
                  <a href={`https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-${updateInfo.version}.dmg`} target="_blank" rel="noopener noreferrer" onClick={dismiss}
                    className="flex-1 py-2 rounded-xl bg-accent hover:bg-accent text-foreground text-xs font-medium text-center no-underline">Intel</a>
                </div>
              ) : (
                <a href={`https://github.com/babyvibe/deplao-builder/releases/tag/v${updateInfo.version}`} target="_blank" rel="noopener noreferrer"
                  className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium text-center no-underline">
                  Tải thủ công
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
