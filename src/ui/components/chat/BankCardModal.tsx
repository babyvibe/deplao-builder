import React, { useEffect, useState } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { cacheSentBankCard } from '@/lib/bankCardCache';

// Danh sách ngân hàng phổ biến Việt Nam (BinBankCard enum values)
const BANK_LIST: { name: string; bin: number }[] = [
  { name: 'Vietcombank', bin: 970436 },
  { name: 'VietinBank', bin: 970415 },
  { name: 'BIDV', bin: 970418 },
  { name: 'Techcombank', bin: 970407 },
  { name: 'MB Bank', bin: 970422 },
  { name: 'ACB', bin: 970416 },
  { name: 'VPBank', bin: 970432 },
  { name: 'TPBank', bin: 970423 },
  { name: 'Sacombank', bin: 970403 },
  { name: 'HDBank', bin: 970437 },
  { name: 'Agribank', bin: 970405 },
  { name: 'SHB', bin: 970443 },
  { name: 'Eximbank', bin: 970431 },
  { name: 'MSB', bin: 970426 },
  { name: 'OCB', bin: 970448 },
  { name: 'VIB', bin: 970441 },
  { name: 'SeABank', bin: 970440 },
  { name: 'LPBank', bin: 970449 },
  { name: 'Nam A Bank', bin: 970428 },
  { name: 'SCB', bin: 970429 },
  { name: 'ABBank', bin: 970425 },
  { name: 'BacA Bank', bin: 970409 },
  { name: 'PVcomBank', bin: 970412 },
  { name: 'NCB', bin: 970419 },
  { name: 'VietABank', bin: 970427 },
  { name: 'DongA Bank', bin: 970406 },
  { name: 'KienlongBank', bin: 970452 },
  { name: 'BVBank', bin: 970454 },
  { name: 'PGBank', bin: 970430 },
  { name: 'VietBank', bin: 970433 },
  { name: 'BaoViet Bank', bin: 970438 },
  { name: 'CB Bank', bin: 970444 },
  { name: 'Coop Bank', bin: 970446 },
  { name: 'Saigon Bank', bin: 970400 },
  { name: 'GPBank', bin: 970408 },
  { name: 'Ocean Bank', bin: 970414 },
  { name: 'Shinhan Bank', bin: 970424 },
  { name: 'HSBC', bin: 458761 },
  { name: 'CAKE', bin: 546034 },
  { name: 'Timo', bin: 963388 },
  { name: 'TNEX', bin: 9704261 },
  { name: 'UBank', bin: 546035 },
  { name: 'KBank', bin: 668888 },
].sort((a, b) => a.name.localeCompare(b.name));

interface BankCard {
  id?: number;
  owner_zalo_id: string;
  bank_name: string;
  bin_bank: number;
  account_number: string;
  account_name: string;
  is_default: number;
}

interface Props {
  threadId: string;
  threadType: number;
  onClose: () => void;
}

export default function BankCardModal({ threadId, threadType, onClose }: Props) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const { showNotification } = useAppStore();
  const [cards, setCards] = useState<BankCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<number | null>(null);

  // Edit form state
  const [editMode, setEditMode] = useState<'list' | 'form'>('list');
  const [editCard, setEditCard] = useState<Partial<BankCard> | null>(null);

  const loadCards = async () => {
    if (!activeAccountId) return;
    setLoading(true);
    try {
      const res = await ipc.db?.getBankCards({ zaloId: activeAccountId });
      if (res?.success) setCards(res.cards || []);
    } catch { }
    setLoading(false);
  };

  useEffect(() => { loadCards(); }, [activeAccountId]);

  const handleSave = async () => {
    if (!activeAccountId || !editCard) return;
    if (!editCard.bin_bank || !editCard.account_number) {
      showNotification('Vui lòng chọn ngân hàng và nhập số tài khoản', 'error');
      return;
    }
    try {
      const bankInfo = BANK_LIST.find(b => b.bin === editCard.bin_bank);
      const res = await ipc.db?.upsertBankCard({
        zaloId: activeAccountId,
        card: {
          id: editCard.id,
          bank_name: bankInfo?.name || editCard.bank_name || '',
          bin_bank: editCard.bin_bank,
          account_number: editCard.account_number || '',
          account_name: editCard.account_name || '',
          is_default: editCard.is_default ?? 0,
        }
      });
      if (res?.success) {
        showNotification(editCard.id ? 'Đã cập nhật thẻ ngân hàng' : 'Đã thêm thẻ ngân hàng', 'success');
        setEditMode('list');
        setEditCard(null);
        loadCards();
      }
    } catch (e: any) {
      showNotification('Lỗi lưu thẻ: ' + (e.message || ''), 'error');
    }
  };

  const handleDelete = async (id: number) => {
    if (!activeAccountId) return;
    try {
      await ipc.db?.deleteBankCard({ zaloId: activeAccountId, id });
      showNotification('Đã xóa thẻ ngân hàng', 'success');
      loadCards();
    } catch { }
  };

  const handleSend = async (card: BankCard) => {
    if (!activeAccountId || !threadId) return;
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    if (!accObj) return;
    const auth = { cookies: accObj.cookies, imei: accObj.imei, userAgent: accObj.user_agent };
    setSending(card.id ?? -1);
    try {
      // Cache bank data trước khi gửi → BankCardBubble dùng để render UI
      const bankName = BANK_LIST.find(b => b.bin === card.bin_bank)?.name || `Bank (${card.bin_bank})`;
      cacheSentBankCard(activeAccountId, threadId, {
        binBank: card.bin_bank,
        bankName,
        numAccBank: card.account_number,
        nameAccBank: card.account_name,
      });

      const res = await ipc.zalo?.sendBankCard({
        auth,
        payload: {
          binBank: card.bin_bank,
          numAccBank: card.account_number,
          nameAccBank: card.account_name,
        },
        threadId,
        type: threadType,
      });
      if (res?.success) {
        showNotification('Đã gửi thẻ ngân hàng thành công!', 'success');
        onClose();
      } else {
        showNotification('Lỗi gửi thẻ: ' + (res?.error || 'Unknown'), 'error');
      }
    } catch (e: any) {
      showNotification('Lỗi gửi thẻ: ' + (e.message || ''), 'error');
    }
    setSending(null);
  };

  // Click outside to close
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] bg-black/50 flex items-center justify-center"
      onClick={handleOverlayClick}
    >
      <div className="bg-gray-800 rounded-xl border border-gray-700 shadow-xl w-[480px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
              <rect x="2" y="4" width="20" height="16" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
              <line x1="6" y1="14" x2="10" y2="14" /><line x1="6" y1="17" x2="14" y2="17" />
            </svg>
            {editMode === 'form' ? (editCard?.id ? 'Sửa thẻ ngân hàng' : 'Thêm thẻ ngân hàng') : 'Gửi thẻ ngân hàng'}
          </h3>
          <div className="flex items-center gap-1">
            {editMode === 'list' && (
              <button
                onClick={() => { setEditCard({ bin_bank: 0, account_number: '', account_name: '', is_default: 0 }); setEditMode('form'); }}
                className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-md transition-colors"
              >
                + Thêm thẻ
              </button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {editMode === 'form' && editCard ? (
            /* ─── Form thêm/sửa ───────────────────────── */
            <div className="space-y-3">
              {/* Ngân hàng */}
              <div className="space-y-1">
                <label className="text-gray-400 text-xs">Ngân hàng *</label>
                <select
                  value={editCard.bin_bank || 0}
                  onChange={(e) => {
                    const bin = Number(e.target.value);
                    const bankInfo = BANK_LIST.find(b => b.bin === bin);
                    setEditCard({ ...editCard, bin_bank: bin, bank_name: bankInfo?.name || '' });
                  }}
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value={0}>-- Chọn ngân hàng --</option>
                  {BANK_LIST.map(b => (
                    <option key={b.bin} value={b.bin}>{b.name}</option>
                  ))}
                </select>
              </div>

              {/* Số tài khoản */}
              <div className="space-y-1">
                <label className="text-gray-400 text-xs">Số tài khoản *</label>
                <input
                  type="text"
                  value={editCard.account_number || ''}
                  onChange={(e) => setEditCard({ ...editCard, account_number: e.target.value })}
                  placeholder="Nhập số tài khoản"
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Tên chủ tài khoản */}
              <div className="space-y-1">
                <label className="text-gray-400 text-xs">Tên chủ tài khoản</label>
                <input
                  type="text"
                  value={editCard.account_name || ''}
                  onChange={(e) => setEditCard({ ...editCard, account_name: e.target.value.toUpperCase() })}
                  placeholder="VD: NGUYEN VAN A"
                  className="w-full bg-gray-700 border border-gray-600 rounded-md px-3 py-2 text-sm text-white uppercase focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Mặc định */}
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!editCard.is_default}
                  onChange={(e) => setEditCard({ ...editCard, is_default: e.target.checked ? 1 : 0 })}
                  className="accent-blue-500"
                />
                Đặt làm thẻ mặc định
              </label>

              {/* Buttons */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={!editCard.bin_bank || !editCard.account_number}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm py-2 rounded-md transition-colors"
                >
                  {editCard.id ? 'Cập nhật' : 'Thêm thẻ'}
                </button>
                <button
                  onClick={() => { setEditMode('list'); setEditCard(null); }}
                  className="px-4 bg-gray-600 hover:bg-gray-500 text-white text-sm py-2 rounded-md transition-colors"
                >
                  Hủy
                </button>
              </div>
            </div>
          ) : (
            /* ─── Danh sách thẻ ───────────────────────── */
            <>
              {loading ? (
                <div className="text-center text-gray-400 py-8 text-sm">Đang tải...</div>
              ) : cards.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-gray-400 text-sm mb-3">Chưa có thẻ ngân hàng nào</div>
                  <button
                    onClick={() => { setEditCard({ bin_bank: 0, account_number: '', account_name: '', is_default: 0 }); setEditMode('form'); }}
                    className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-md transition-colors"
                  >
                    + Thêm thẻ mới
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {cards.map((card) => (
                    <div
                      key={card.id}
                      className="bg-gray-700/60 border border-gray-600 rounded-lg p-3 hover:border-blue-500/50 transition-colors group"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-white text-sm">{card.bank_name}</span>
                            {card.is_default === 1 && (
                              <span className="text-[10px] bg-blue-600/30 text-blue-300 px-1.5 py-0.5 rounded">Mặc định</span>
                            )}
                          </div>
                          <div className="text-gray-300 text-sm font-mono">{card.account_number}</div>
                          {card.account_name && (
                            <div className="text-gray-400 text-xs mt-0.5">{card.account_name}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleSend(card)}
                            disabled={sending !== null}
                            className="bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded-md transition-colors flex items-center gap-1"
                            title="Gửi thẻ này"
                          >
                            {sending === card.id ? (
                              <span className="animate-spin">⏳</span>
                            ) : (
                              <>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M22 2L11 13" /><path d="M22 2L15 22l-4-9-9-4z" />
                                </svg>
                                Gửi
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => { setEditCard(card); setEditMode('form'); }}
                            className="text-gray-400 hover:text-blue-400 p-1.5 rounded transition-colors"
                            title="Sửa"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => card.id && handleDelete(card.id)}
                            className="text-gray-400 hover:text-red-400 p-1.5 rounded transition-colors"
                            title="Xóa"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

