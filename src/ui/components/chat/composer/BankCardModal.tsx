import React, { useEffect, useState } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { cacheSentBankCard } from '@/lib/chat/zalo/bankCardCache';
import { tr } from '../../../../shared/i18n';

// List of popular banks in Vietnam (BinBankCard enum values)
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
      // DataAccessor: employee mode reads the cards from Boss (IPC returns an empty stub → the card list is empty); an error keeps the old list
      const res = await DataAccessor.getBankCards({ zaloId: activeAccountId });
      if (res?.success) setCards(res.cards || []);
    } catch { }
    setLoading(false);
  };

  useEffect(() => { loadCards(); }, [activeAccountId]);

  const handleSave = async () => {
    if (!activeAccountId || !editCard) return;
    if (!editCard.bin_bank || !editCard.account_number) {
      showNotification(tr('Vui lòng chọn ngân hàng và nhập số tài khoản'), 'error');
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
        showNotification(editCard.id ? tr('Đã cập nhật thẻ ngân hàng') : tr('Đã thêm thẻ ngân hàng'), 'success');
        setEditMode('list');
        setEditCard(null);
        loadCards();
      } else {
        // Employee: the card is saved on Boss. If Boss rejects it or the connection is lost, show an error (previously silent)
        showNotification(tr('Lỗi lưu thẻ: {{v1}}', { v1: ((res as any)?.error || tr('không lưu được')) }), 'error');
      }
    } catch (e: any) {
      showNotification(tr('Lỗi lưu thẻ: {{v1}}', { v1: (e.message || '') }), 'error');
    }
  };

  const handleDelete = async (id: number) => {
    if (!activeAccountId) return;
    try {
      const res: any = await ipc.db?.deleteBankCard({ zaloId: activeAccountId, id });
      if (res?.success === false) {
        showNotification(tr('Lỗi xóa thẻ: {{v1}}', { v1: (res.error || tr('không xóa được')) }), 'error');
        return;
      }
      showNotification(tr('Đã xóa thẻ ngân hàng'), 'success');
      loadCards();
    } catch { }
  };

  const handleSend = async (card: BankCard) => {
    if (!activeAccountId || !threadId) return;
    const accObj = useAccountStore.getState().accounts.find(a => a.zalo_id === activeAccountId);
    if (!accObj) return;
    const auth = buildZaloAuth(accObj);
    setSending(card.id ?? -1);
    try {
      // Cache the bank data before sending → BankCardBubble uses it to render the UI
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
        showNotification(tr('Đã gửi thẻ ngân hàng thành công!'), 'success');
        onClose();
      } else {
        showNotification(tr('Lỗi gửi thẻ: {{v1}}', { v1: (res?.error || 'Unknown') }), 'error');
      }
    } catch (e: any) {
      showNotification(tr('Lỗi gửi thẻ: {{v1}}', { v1: (e.message || '') }), 'error');
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
      <div className="bg-card rounded-xl border border-border shadow-xl w-[480px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-foreground font-semibold text-sm flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
              <rect x="2" y="4" width="20" height="16" rx="2" /><line x1="2" y1="10" x2="22" y2="10" />
              <line x1="6" y1="14" x2="10" y2="14" /><line x1="6" y1="17" x2="14" y2="17" />
            </svg>
            {editMode === 'form' ? (editCard?.id ? tr('Sửa thẻ ngân hàng') : tr('Thêm thẻ ngân hàng')) : tr('Gửi thẻ ngân hàng')}
          </h3>
          <div className="flex items-center gap-1">
            {editMode === 'list' && (
              <button
                onClick={() => { setEditCard({ bin_bank: 0, account_number: '', account_name: '', is_default: 0 }); setEditMode('form'); }}
                className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-md transition-colors"
              >
                {tr('+ Thêm thẻ')}
              </button>
            )}
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {editMode === 'form' && editCard ? (
            /* ─── Add / edit form ───────────────────────── */
            <div className="space-y-3">
              {/* Bank */}
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">{tr('Ngân hàng *')}</label>
                <select
                  value={editCard.bin_bank || 0}
                  onChange={(e) => {
                    const bin = Number(e.target.value);
                    const bankInfo = BANK_LIST.find(b => b.bin === bin);
                    setEditCard({ ...editCard, bin_bank: bin, bank_name: bankInfo?.name || '' });
                  }}
                  className="w-full bg-muted border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
                >
                  <option value={0}>{tr('-- Chọn ngân hàng --')}</option>
                  {BANK_LIST.map(b => (
                    <option key={b.bin} value={b.bin}>{b.name}</option>
                  ))}
                </select>
              </div>

              {/* Account number */}
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">{tr('Số tài khoản *')}</label>
                <input
                  type="text"
                  value={editCard.account_number || ''}
                  onChange={(e) => setEditCard({ ...editCard, account_number: e.target.value })}
                  placeholder={tr('Nhập số tài khoản')}
                  className="w-full bg-muted border border-input rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Account holder name */}
              <div className="space-y-1">
                <label className="text-muted-foreground text-xs">{tr('Tên chủ tài khoản')}</label>
                <input
                  type="text"
                  value={editCard.account_name || ''}
                  onChange={(e) => setEditCard({ ...editCard, account_name: e.target.value.toUpperCase() })}
                  placeholder={tr('VD: NGUYEN VAN A')}
                  className="w-full bg-muted border border-input rounded-md px-3 py-2 text-sm text-foreground uppercase focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Default */}
              <label className="flex items-center gap-2 text-sm text-foreground/80 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!editCard.is_default}
                  onChange={(e) => setEditCard({ ...editCard, is_default: e.target.checked ? 1 : 0 })}
                  className="accent-blue-500"
                />
                {tr('Đặt làm thẻ mặc định')}
              </label>

              {/* Buttons */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={!editCard.bin_bank || !editCard.account_number}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm py-2 rounded-md transition-colors"
                >
                  {editCard.id ? tr('Cập nhật') : tr('Thêm thẻ')}
                </button>
                <button
                  onClick={() => { setEditMode('list'); setEditCard(null); }}
                  className="px-4 bg-accent hover:bg-accent text-foreground text-sm py-2 rounded-md transition-colors"
                >
                  {tr('Hủy')}
                </button>
              </div>
            </div>
          ) : (
            /* ─── Card list ───────────────────────── */
            <>
              {loading ? (
                <div className="text-center text-muted-foreground py-8 text-sm">{tr('Đang tải...')}</div>
              ) : cards.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-muted-foreground text-sm mb-3">{tr('Chưa có thẻ ngân hàng nào')}</div>
                  <button
                    onClick={() => { setEditCard({ bin_bank: 0, account_number: '', account_name: '', is_default: 0 }); setEditMode('form'); }}
                    className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-md transition-colors"
                  >
                    {tr('+ Thêm thẻ mới')}
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {cards.map((card) => (
                    <div
                      key={card.id}
                      className="bg-muted/60 border border-input rounded-lg p-3 hover:border-blue-500/50 transition-colors group"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-foreground text-sm">{card.bank_name}</span>
                            {card.is_default === 1 && (
                              <span className="text-[10px] bg-blue-600/30 text-blue-300 px-1.5 py-0.5 rounded">{tr('Mặc định')}</span>
                            )}
                          </div>
                          <div className="text-foreground/80 text-sm font-mono">{card.account_number}</div>
                          {card.account_name && (
                            <div className="text-muted-foreground text-xs mt-0.5">{card.account_name}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleSend(card)}
                            disabled={sending !== null}
                            className="bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded-md transition-colors flex items-center gap-1"
                            title={tr('Gửi thẻ này')}
                          >
                            {sending === card.id ? (
                              <span className="animate-spin">⏳</span>
                            ) : (
                              <>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M22 2L11 13" /><path d="M22 2L15 22l-4-9-9-4z" />
                                </svg>
                                {tr('Gửi')}
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => { setEditCard(card); setEditMode('form'); }}
                            className="text-muted-foreground hover:text-blue-400 p-1.5 rounded transition-colors"
                            title={tr('Sửa')}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => card.id && handleDelete(card.id)}
                            className="text-muted-foreground hover:text-red-400 p-1.5 rounded transition-colors"
                            title={tr('Xóa')}
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

