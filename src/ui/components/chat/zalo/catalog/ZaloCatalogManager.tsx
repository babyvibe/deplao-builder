/**
 * Quản lý danh mục sản phẩm Zalo Business (ZL-04): thêm / đổi tên / xoá danh mục; thêm / sửa / xoá sản phẩm (tên, giá,
 * mô tả, tối đa 5 ảnh). Ảnh tải lên bằng uploadProductPhoto trước rồi gửi URL (zca-js 2.2.0 bỏ qua `files`).
 * Xoá trên Zalo không hoàn tác được → luôn hỏi lại. Máy nhân viên ghi cần quyền CRM (quyết định Q7).
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { showConfirm } from '@/components/common/ConfirmDialog';
import {
  ZALO_PRODUCT_MAX_PHOTOS, formatProductPrice, normalizeProductPrice, validateZaloProduct, type ZaloCatalog, type ZaloProduct,
} from '../../../../../shared/zalo/zaloCatalog';
import {
  catalogAuth, invalidateCatalogCache, loadCatalogs, loadProducts, unwrapCatalogResult, uploadProductPhotos,
} from './zaloCatalogData';

interface ProductDraft { id?: string; createdAt?: number; name: string; price: string; description: string; photos: string[] }

const emptyDraft = (): ProductDraft => ({ name: '', price: '', description: '', photos: [] });
const inputClass = 'w-full rounded-lg border border-input bg-muted px-2.5 py-1.5 text-sm text-foreground placeholder-subtle-foreground focus:border-blue-500 focus:outline-none';

export default function ZaloCatalogManager({ accountId, initialCatalogId, onClose }: {
  accountId: string;
  initialCatalogId?: string;
  onClose: () => void;
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [catalogs, setCatalogs] = React.useState<ZaloCatalog[]>([]);
  const [catalogId, setCatalogId] = React.useState(initialCatalogId || '');
  const [products, setProducts] = React.useState<ZaloProduct[]>([]);
  const [newCatalog, setNewCatalog] = React.useState('');
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const [draft, setDraft] = React.useState<ProductDraft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try { await task(); } catch (err: any) { setError(err?.message || 'Zalo từ chối thao tác'); } finally { setBusy(false); }
  };

  const reloadCatalogs = React.useCallback(async (force: boolean) => {
    const items = await loadCatalogs(accountId, force);
    setCatalogs(items);
    setCatalogId((current) => (items.some((c) => c.id === current) ? current : (items.find((c) => c.isDefault) || items[0])?.id || ''));
  }, [accountId]);

  const reloadProducts = React.useCallback(async (force: boolean) => {
    if (!catalogId) { setProducts([]); return; }
    setProducts((await loadProducts(accountId, catalogId, { force })).items);
  }, [accountId, catalogId]);

  React.useEffect(() => { void reloadCatalogs(false).catch((err) => setError(err?.message || 'Không đọc được danh mục')); }, [reloadCatalogs]);
  React.useEffect(() => { void reloadProducts(false).catch((err) => setError(err?.message || 'Không đọc được sản phẩm')); }, [reloadProducts]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const afterWrite = async () => {
    invalidateCatalogCache(accountId);
    await reloadCatalogs(true);
    await reloadProducts(true);
  };

  const createCatalog = () => run(async () => {
    const name = newCatalog.trim();
    if (!name) throw new Error('Nhập tên danh mục');
    const created = unwrapCatalogResult<ZaloCatalog>(await ipc.zalo?.createCatalog({ auth: catalogAuth(accountId), name }), 'Không tạo được danh mục');
    setNewCatalog('');
    if (created?.id) setCatalogId(created.id);
    await afterWrite();
  });

  const renameCatalog = () => run(async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) throw new Error('Nhập tên danh mục');
    unwrapCatalogResult(await ipc.zalo?.updateCatalog({ auth: catalogAuth(accountId), catalogId: renaming.id, name }), 'Không đổi tên được');
    setRenaming(null);
    await afterWrite();
  });

  const deleteCatalog = (catalog: ZaloCatalog) => run(async () => {
    const ok = await showConfirm({
      title: `Xoá danh mục "${catalog.name}"?`,
      message: `Danh mục và ${catalog.totalProduct} sản phẩm bị xoá trên Zalo, không hoàn tác được.`,
      confirmText: 'Xoá', variant: 'danger',
    });
    if (!ok) return;
    unwrapCatalogResult(await ipc.zalo?.deleteCatalog({ auth: catalogAuth(accountId), catalogId: catalog.id }), 'Không xoá được danh mục');
    await afterWrite();
  });

  const pickPhotos = () => run(async () => {
    if (!draft) return;
    const room = ZALO_PRODUCT_MAX_PHOTOS - draft.photos.length;
    if (room <= 0) throw new Error(`Tối đa ${ZALO_PRODUCT_MAX_PHOTOS} ảnh mỗi sản phẩm`);
    const picked: any = await ipc.file?.openDialog({ multiSelect: true, filters: [{ name: 'Ảnh', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    const paths: string[] = (picked?.filePaths || []).slice(0, room);
    if (paths.length === 0) return;
    const urls = await uploadProductPhotos(accountId, paths);
    setDraft((d) => (d ? { ...d, photos: [...d.photos, ...urls].slice(0, ZALO_PRODUCT_MAX_PHOTOS) } : d));
  });

  const saveProduct = () => run(async () => {
    if (!draft || !catalogId) return;
    const problem = validateZaloProduct(draft);
    if (problem) throw new Error(problem);
    const product = {
      catalogId, name: draft.name.trim(), price: normalizeProductPrice(draft.price), description: draft.description.trim(), photos: draft.photos,
    };
    const res = draft.id
      ? await ipc.zalo?.updateCatalogProduct({ auth: catalogAuth(accountId), product: { ...product, productId: draft.id, createTime: draft.createdAt || Date.now() } })
      : await ipc.zalo?.createCatalogProduct({ auth: catalogAuth(accountId), product });
    unwrapCatalogResult(res, draft.id ? 'Không lưu được sản phẩm' : 'Không tạo được sản phẩm');
    showNotification(draft.id ? 'Đã lưu sản phẩm' : 'Đã thêm sản phẩm', 'success');
    setDraft(null);
    await afterWrite();
  });

  const deleteProduct = (product: ZaloProduct) => run(async () => {
    const ok = await showConfirm({ title: `Xoá "${product.name}"?`, message: 'Sản phẩm bị xoá trên Zalo, không hoàn tác được.', confirmText: 'Xoá', variant: 'danger' });
    if (!ok) return;
    unwrapCatalogResult(await ipc.zalo?.deleteCatalogProducts({ auth: catalogAuth(accountId), catalogId, productIds: [product.id] }), 'Không xoá được sản phẩm');
    await afterWrite();
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => { if (!busy) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-input bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <p className="flex-1 text-sm font-semibold text-foreground">Quản lý danh mục sản phẩm (Zalo Business)</p>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Đóng"
            className="rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">✕</button>
        </div>
        {error && <p role="alert" className="border-b border-border px-4 py-2 text-xs text-destructive">{error}</p>}

        <div className="flex min-h-0 flex-1">
          <aside className="w-56 flex-shrink-0 space-y-1 overflow-y-auto border-r border-border p-3">
            {catalogs.map((c) => (
              <div key={c.id} className={`group rounded-lg px-2 py-1.5 ${c.id === catalogId ? 'bg-muted' : 'hover:bg-muted/60'}`}>
                {renaming?.id === c.id ? (
                  <div className="flex gap-1">
                    <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') void renameCatalog(); if (e.key === 'Escape') setRenaming(null); }}
                      className={inputClass} />
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => { setCatalogId(c.id); setDraft(null); }} className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
                      {c.name} <span className="text-xs text-muted-foreground">· {c.totalProduct}</span>
                    </button>
                    <button type="button" title="Đổi tên" onClick={() => setRenaming({ id: c.id, name: c.name })}
                      className="hidden text-xs text-muted-foreground hover:text-foreground group-hover:inline">Sửa</button>
                    {!c.isDefault && (
                      <button type="button" title="Xoá danh mục" onClick={() => void deleteCatalog(c)}
                        className="hidden text-xs text-destructive group-hover:inline">Xoá</button>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div className="flex gap-1 pt-2">
              <input value={newCatalog} onChange={(e) => setNewCatalog(e.target.value)} placeholder="Danh mục mới"
                onKeyDown={(e) => { if (e.key === 'Enter') void createCatalog(); }} className={inputClass} />
              <button type="button" disabled={busy || !newCatalog.trim()} onClick={() => void createCatalog()}
                className="flex-shrink-0 rounded-lg bg-blue-600 px-2 text-sm text-white disabled:opacity-50">+</button>
            </div>
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto p-3">
            {draft ? (
              <div className="space-y-2.5">
                <p className="text-sm font-semibold text-foreground">{draft.id ? 'Sửa sản phẩm' : 'Thêm sản phẩm'}</p>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Tên sản phẩm" className={inputClass} />
                <input value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="Giá (VNĐ)" inputMode="numeric" className={inputClass} />
                <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Mô tả" rows={4}
                  className={`${inputClass} resize-none`} />
                <div className="flex flex-wrap gap-2">
                  {draft.photos.map((url, i) => (
                    <div key={url} className="relative h-16 w-16 overflow-hidden rounded-lg border border-border">
                      <img src={url} alt="" className="h-full w-full object-cover" />
                      <button type="button" aria-label="Bỏ ảnh" onClick={() => setDraft({ ...draft, photos: draft.photos.filter((_, j) => j !== i) })}
                        className="absolute right-0.5 top-0.5 rounded-full bg-black/60 px-1 text-[10px] text-white">✕</button>
                    </div>
                  ))}
                  {draft.photos.length < ZALO_PRODUCT_MAX_PHOTOS && (
                    <button type="button" disabled={busy} onClick={() => void pickPhotos()}
                      className="h-16 w-16 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:bg-muted disabled:opacity-50">+ Ảnh</button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">Tối đa {ZALO_PRODUCT_MAX_PHOTOS} ảnh. Lưu xong sản phẩm hiện ngay trên Zalo của tài khoản.</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDraft(null)} disabled={busy}
                    className="flex-1 rounded-xl py-2 text-sm text-muted-foreground hover:bg-muted">Huỷ</button>
                  <button type="button" onClick={() => void saveProduct()} disabled={busy}
                    className="flex-1 rounded-xl bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50">
                    {busy ? 'Đang lưu...' : 'Lưu sản phẩm'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">{products.length} sản phẩm</p>
                  <button type="button" disabled={!catalogId || busy} onClick={() => setDraft(emptyDraft())}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50">+ Thêm sản phẩm</button>
                </div>
                <div className="divide-y divide-border">
                  {products.map((p) => (
                    <div key={p.id} className="group flex items-center gap-3 py-2">
                      <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                        {p.photos[0] && <img src={p.photos[0]} alt="" loading="lazy" className="h-full w-full object-cover" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-foreground">{p.name}</p>
                        <p className="text-xs text-blue-500">{formatProductPrice(p.price, p.currency)}</p>
                      </div>
                      <button type="button" onClick={() => setDraft({ id: p.id, createdAt: p.createdAt, name: p.name, price: p.price, description: p.description, photos: p.photos })}
                        className="text-xs text-muted-foreground hover:text-foreground">Sửa</button>
                      <button type="button" onClick={() => void deleteProduct(p)} className="text-xs text-destructive">Xoá</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
