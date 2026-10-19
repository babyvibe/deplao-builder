/**
 * PluginPagesHost — view 'plugin'.
 *  - Chưa chọn trang → PluginHub (lưới ứng dụng, nút Mở).
 *  - Đã chọn → thanh trên (quay lại danh sách, biểu tượng, tab các trang của plugin, tải lại) + iframe.
 * Giữ tối đa 5 iframe đã mở (ẩn bằng CSS khi chuyển view) để plugin không mất trạng thái; trang cũ nhất bị gỡ trước.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import { ArrowLeftIcon, PluginIcon, RefreshIcon } from '@/components/common/icons';
import PluginFrame from './PluginFrame';
import PluginHub from './PluginHub';
import PluginAvatar from './PluginAvatar';

const MAX_ALIVE = 5;

export default function PluginPagesHost() {
  const view = useAppStore(s => s.view);
  const active = useAppStore(s => s.activePluginPage);
  const openPluginHub = useAppStore(s => s.openPluginHub);
  const openPluginPage = useAppStore(s => s.openPluginPage);
  const pages = usePluginStore(s => s.contributions.pages);
  const plugins = usePluginStore(s => s.plugins);
  const [alive, setAlive] = useState<string[]>([]);
  const [nonce, setNonce] = useState<Record<string, number>>({});

  const activeKey = active ? `${active.pluginId}::${active.pageId}` : '';
  const visible = view === 'plugin';
  const showHub = visible && !active;

  useEffect(() => {
    if (!visible || !activeKey) return;
    setAlive(prev => [...prev.filter(k => k !== activeKey), activeKey].slice(-MAX_ALIVE));
  }, [visible, activeKey]);

  const byKey = useMemo(() => new Map(pages.map(p => [`${p.pluginId}::${p.id}`, p])), [pages]);
  const live = alive.filter(k => byKey.has(k));

  if (!visible && !live.length) return null;
  const current = byKey.get(activeKey);
  const plugin = current ? plugins.find(p => p.id === current.pluginId) : undefined;
  const siblings = current ? pages.filter(p => p.pluginId === current.pluginId) : [];
  const showFrames = visible && !showHub;

  return (
    <>
      {showHub && <PluginHub />}
      <div className={showFrames ? 'flex-1 h-full overflow-hidden flex flex-col' : 'hidden'}>
        {showFrames && (
          <div className="h-11 flex-shrink-0 flex items-center gap-2 px-2 border-b border-border bg-card">
            <button
              type="button"
              onClick={openPluginHub}
              title="Về danh sách ứng dụng"
              className="flex items-center gap-1.5 h-8 px-2 rounded-lg text-xs text-foreground/80 hover:bg-muted hover:text-foreground"
            >
              <ArrowLeftIcon className="w-4 h-4" />
              <span>Tất cả ứng dụng</span>
            </button>
            {current && (
              <>
                <span className="w-px h-5 bg-muted" />
                <PluginAvatar id={current.pluginId} name={current.pluginName} icon={plugin?.icon} size={24} rounded={7} />
                <span className="text-sm font-medium text-foreground truncate max-w-[220px]">{current.pluginName}</span>
                {siblings.length > 1 && (
                  <div className="flex items-center gap-1 ml-2 overflow-x-auto">
                    {siblings.map(pg => {
                      const on = pg.id === current.id;
                      return (
                        <button
                          key={pg.id}
                          type="button"
                          onClick={() => openPluginPage(pg.pluginId, pg.id)}
                          className={`h-7 px-3 rounded-lg text-xs whitespace-nowrap transition-colors ${on ? 'bg-primary/20 text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                        >
                          {pg.title}
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  title="Tải lại trang ứng dụng"
                  onClick={() => setNonce(n => ({ ...n, [activeKey]: (n[activeKey] || 0) + 1 }))}
                  className="ml-auto w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <RefreshIcon className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        )}
        {showFrames && !current && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <PluginIcon className="w-8 h-8 text-subtle-foreground" />
            <p className="text-sm text-muted-foreground">Trang của ứng dụng không còn khả dụng (ứng dụng đã tắt hoặc bị gỡ).</p>
            <button type="button" className="text-xs text-primary hover:text-primary-hover" onClick={openPluginHub}>Về danh sách ứng dụng</button>
          </div>
        )}
        <div className={showFrames && current ? 'flex-1 relative' : 'hidden'}>
          {live.map(k => (
            <div key={`${k}#${nonce[k] || 0}`} className={showFrames && k === activeKey ? 'absolute inset-0' : 'hidden'}>
              <PluginFrame contribution={byKey.get(k)!} kind="page" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
