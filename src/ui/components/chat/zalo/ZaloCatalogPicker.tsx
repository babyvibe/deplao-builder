/**
 * Nút "Sản phẩm" trên thanh công cụ soạn tin (ZL-04, chỉ tài khoản Zalo Business): chọn danh mục, tìm sản phẩm, gửi vào
 * hội thoại dưới dạng link catalog.zalo.me kèm tên + giá. Chọn nhiều → gửi lần lượt, cách nhau ít nhất 2 s (quyết định Q8).
 * "Quản lý" mở cửa sổ thêm / sửa / xoá danh mục và sản phẩm.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { foldSearchText } from '../../../../shared/searchFold';
import {
  ZALO_PRODUCT_SEND_GAP_MS, formatProductPrice, productShareText, type ZaloCatalog, type ZaloProduct,
} from '../../../../shared/zaloCatalog';
import { catalogAuth, loadCatalogs, loadProducts } from './zaloCatalogData';
import ZaloCatalogManager from './ZaloCatalogManager';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function ZaloCatalogPicker({ accountId, threadId, threadType, onClose }: {
  accountId: string;
  threadId: string;
  threadType: number;
  onClose: () => void;
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [catalogs, setCatalogs] = React.useState<ZaloCatalog[] | null>(null);
  const [catalogId, setCatalogId] = React.useState('');
  const [products, setProducts] = React.useState<ZaloProduct[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [sending, setSending] = React.useState<{ done: number; total: number } | null>(null);
  const [managing, setManaging] = React.useState(false);
  const cancelled = React.useRef(false);

  const refreshCatalogs = React.useCallback(async (force = false) => {
    setError('');
    try {
      const items = await loadCatalogs(accountId, force);
      setCatalogs(items);
      setCatalogId((current) => (items.some((c) => c.id === current) ? current : (items.find((c) => c.isDefault) || items[0])?.id || ''));
    } catch (err: any) {
      setCatalogs([]);
      setError(err?.message || 'Không đọc được danh mục');
    }
  }, [accountId]);

  React.useEffect(() => {
    cancelled.current = false;
    void refreshCatalogs(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { cancelled.current = true; document.removeEventListener('keydown', onKey); };
  }, [refreshCatalogs, onClose]);

  const refreshProducts = React.useCallback(async (opts: { force?: boolean; more?: boolean } = {}) => {
    if (!catalogId) { setProducts([]); setHasMore(false); return; }
    setLoading(true);
    setError('');
    try {
      const res = await loadProducts(accountId, catalogId, opts);
      setProducts(res.items);
      setHasMore(res.hasMore);
    } catch (err: any) {
      setError(err?.message || 'Không đọc được sản phẩm');
    } finally {
      setLoading(false);
    }
  }, [accountId, catalogId]);

  React.useEffect(() => { setSelected([]); void refreshProducts(); }, [refreshProducts]);

  const folded = foldSearchText(query.trim());
  const visible = folded ? products.filter((p) => foldSearchText(`${p.name} ${p.description}`).includes(folded)) : products;
  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const sendLinks = async (items: Array<{ url: string; text: string }>) => {
    if (items.length === 0 || sending) return;
    setSending({ done: 0, total: items.length });
    let sent = 0;
    try {
      for (let i = 0; i < items.length && !cancelled.current; i++) {
        if (i > 0) await sleep(ZALO_PRODUCT_SEND_GAP_MS);
        const res = await ipc.zalo?.sendLink({ auth: catalogAuth(accountId), url: items[i].url, message: items[i].text, threadId, type: threadType });
        if (!res?.success) throw new Error(res?.error || 'Zalo từ chối gửi');
        sent++;
        setSending({ done: sent, total: items.length });
      }
      showNotification(sent > 1 ? `Đã gửi ${sent} sản phẩm` : 'Đã gửi sản phẩm', 'success');
      onClose();
    } catch (err: any) {
      showNotification(`Đã gửi ${sent}/${items.length} — ${err?.message || 'lỗi gửi'}`, 'error');
      setSending(null);
    }
  };

  const sendSelected = () => sendLinks(
    selected.map((id) => products.find((p) => p.id === id)).filter((p): p is ZaloProduct => !!p && !!p.url)
      .map((p) => ({ url: p.url, text: productShareText(p) })),
  );
  const activeCatalog = catalogs?.find((c) => c.id === catalogId);

  if (managing) {
    return (
      <ZaloCatalogManager accountId={accountId} initialCatalogId={catalogId}
        onClose={() => { setManaging(false); void refreshCatalogs(true); void refreshProducts({ force: true }); }} />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-input bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <p className="flex-1 text-sm font-semibold text-foreground">Gửi sản phẩm (Zalo Business)</p>
          <button type="button" onClick={() => setManaging(true)}
            className="rounded-lg border border-input px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted">Quản lý</button>
          <button type="button" onClick={onClose} aria-label="Đóng"
            className="rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">✕</button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <select value={catalogId} onChange={(e) => setCatalogId(e.target.value)} aria-label="Danh mục"
            className="min-w-0 flex-1 rounded-lg border border-input bg-muted px-2 py-1.5 text-sm text-foreground">
            {(catalogs || []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.isDefault ? ' (mặc định)' : ''} · {c.totalProduct}</option>)}
          </select>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm sản phẩm..."
            className="min-w-0 flex-1 rounded-lg border border-input bg-muted px-2 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none" />
        </div>

        <div className="min-h-[180px] flex-1 overflow-y-auto p-3">
          {error && <p role="alert" className="mb-2 text-xs text-destructive">{error}</p>}
          {catalogs === null || (loading && products.length === 0) ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Đang đọc từ Zalo...</p>
          ) : catalogs.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Chưa có danh mục — bấm "Quản lý" để tạo.</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{query ? 'Không có sản phẩm khớp' : 'Danh mục chưa có sản phẩm'}</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {visible.map((p) => {
                const on = selected.includes(p.id);
                return (
                  <button key={p.id} type="button" onClick={() => toggle(p.id)} aria-pressed={on}
                    className={`overflow-hidden rounded-xl border text-left transition-colors ${on ? 'border-blue-500 ring-1 ring-blue-500' : 'border-border hover:border-border-strong'}`}>
                    <div className="aspect-square w-full bg-muted">
                      {p.photos[0] && <img src={p.photos[0]} alt="" loading="lazy" className="h-full w-full object-cover" />}
                    </div>
                    <div className="p-2">
                      <p className="line-clamp-2 text-xs font-medium text-foreground">{p.name}</p>
                      <p className="mt-0.5 text-xs text-blue-500">{formatProductPrice(p.price, p.currency)}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {hasMore && !query && (
            <button type="button" disabled={loading} onClick={() => void refreshProducts({ more: true })}
              className="mt-3 w-full rounded-lg py-1.5 text-xs text-blue-500 hover:bg-muted disabled:opacity-50">Tải thêm</button>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          {activeCatalog?.url && (
            <button type="button" disabled={!!sending} onClick={() => void sendLinks([{ url: activeCatalog.url, text: activeCatalog.name }])}
              className="rounded-xl px-3 py-2 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50">Gửi cả danh mục</button>
          )}
          <p className="flex-1 text-[11px] text-muted-foreground">
            {sending ? `Đang gửi ${sending.done}/${sending.total}...` : selected.length > 1 ? 'Gửi lần lượt, cách nhau 2 giây' : ''}
          </p>
          <button type="button" disabled={selected.length === 0 || !!sending} onClick={() => void sendSelected()}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50">
            Gửi{selected.length > 0 ? ` (${selected.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
