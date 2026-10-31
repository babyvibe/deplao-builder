/**
 * Dữ liệu danh mục sản phẩm Zalo Business phía giao diện (ZL-04): gọi IPC zalo:* (máy nhân viên tự đi proxy Boss), đệm
 * 5 phút theo tài khoản / danh mục để mở bảng chọn nhiều lần không hỏi Zalo lại (NFR-02); ghi xong thì xoá đệm.
 */
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import type { ZaloCatalog, ZaloProduct } from '../../../../../shared/zalo/zaloCatalog';

const CACHE_MS = 5 * 60_000;
const catalogCache = new Map<string, { at: number; items: ZaloCatalog[] }>();
const productCache = new Map<string, { at: number; items: ZaloProduct[]; hasMore: boolean; page: number }>();

export function catalogAuth(accountId: string) {
  const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
  if (!account) throw new Error('Không tìm thấy tài khoản');
  return buildZaloAuth(account as any, accountId);
}

function unwrap<T>(res: any, fallback: string): T {
  if (!res?.success) throw new Error(res?.error || fallback);
  return res.response as T;
}

export async function loadCatalogs(accountId: string, force = false): Promise<ZaloCatalog[]> {
  const cached = catalogCache.get(accountId);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.items;
  const items: ZaloCatalog[] = [];
  for (let page = 0; page < 10; page++) {
    const res = unwrap<{ items: ZaloCatalog[]; hasMore: boolean }>(
      await ipc.zalo?.getCatalogs({ auth: catalogAuth(accountId), page, limit: 20 }), 'Không đọc được danh mục từ Zalo');
    items.push(...(res.items || []));
    if (!res.hasMore) break;
  }
  catalogCache.set(accountId, { at: Date.now(), items });
  return items;
}

/** Trang sản phẩm đầu (100) — `more` = tải thêm trang kế tiếp vào danh sách đang đệm. */
export async function loadProducts(accountId: string, catalogId: string, opts: { force?: boolean; more?: boolean } = {}): Promise<{ items: ZaloProduct[]; hasMore: boolean }> {
  const key = `${accountId}:${catalogId}`;
  const cached = productCache.get(key);
  if (!opts.force && !opts.more && cached && Date.now() - cached.at < CACHE_MS) return cached;
  const page = opts.more && cached ? cached.page + 1 : 0;
  const res = unwrap<{ items: ZaloProduct[]; hasMore: boolean }>(
    await ipc.zalo?.getCatalogProducts({ auth: catalogAuth(accountId), catalogId, page, limit: 100 }), 'Không đọc được sản phẩm từ Zalo');
  const items = page > 0 && cached ? [...cached.items, ...(res.items || [])] : (res.items || []);
  const next = { at: Date.now(), items, hasMore: !!res.hasMore, page };
  productCache.set(key, next);
  return next;
}

export function invalidateCatalogCache(accountId: string, catalogId?: string): void {
  catalogCache.delete(accountId);
  if (catalogId) productCache.delete(`${accountId}:${catalogId}`);
  else for (const key of Array.from(productCache.keys())) if (key.startsWith(`${accountId}:`)) productCache.delete(key);
}

export async function uploadProductPhotos(accountId: string, paths: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const photoPath of paths) {
    const res = unwrap<{ url: string }>(await ipc.zalo?.uploadProductPhoto({ auth: catalogAuth(accountId), photoPath }), 'Không tải được ảnh lên Zalo');
    if (res?.url) urls.push(res.url);
  }
  return urls;
}

export { unwrap as unwrapCatalogResult };
