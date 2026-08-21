import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  PLANS, createPaymentQr, checkPaymentStatus, getPremiumStatus, validateAffCode,
  type PlanCode, type CreateQrResponse, type CheckPaymentResponse, type ValidateAffCodeResult,
} from '@/lib/backendService';

// ─── Icons ──────────────────────────────────────────────────────────────────

const SpinIcon = (
  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

const CheckIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const AlertIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const RefreshIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.97"/>
  </svg>
);

// ─── Types ──────────────────────────────────────────────────────────────────

interface AccountInfo {
  pageId: string;
  displayName: string;
  expiresAt: string | null;
  avatar?: string;
}

interface PaymentQrSectionProps {
  accounts: AccountInfo[];
  onClose: () => void;
  onPaymentSuccess: () => void;
}

type PaymentStep = 'select' | 'qr' | 'confirm';

const STEP_LABELS: Record<PaymentStep, string> = {
  select: 'Chọn tài khoản & gói',
  qr: 'Quét mã QR',
  confirm: 'Xác nhận thanh toán',
};

const STEP_ORDER: PaymentStep[] = ['select', 'qr', 'confirm'];

const POLL_INTERVAL = 5_000;
const POLL_MAX = 20;

const formatCurrency = (vnd: number) => vnd.toLocaleString('vi-VN') + 'đ';

// ─── Component ──────────────────────────────────────────────────────────────

export default function PaymentQrSection({ accounts, onClose, onPaymentSuccess }: PaymentQrSectionProps) {
  const [step, setStep] = useState<PaymentStep>('select');
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  const [selectedPlan, setSelectedPlan] = useState<PlanCode>('1year');

  // ── Load premium status cho tất cả accounts ──────────────────────────────
  const [accountsData, setAccountsData] = useState<AccountInfo[]>(accounts);

  useEffect(() => {
    let cancelled = false;
    const loadAll = async () => {
      const results = await Promise.all(
        accounts.map(async (acc) => {
          try {
            const res = await getPremiumStatus(acc.pageId);
            return { ...acc, expiresAt: res.expiresAt };
          } catch {
            return acc;
          }
        })
      );
      if (!cancelled) setAccountsData(results);
    };
    loadAll();
    return () => { cancelled = true; };
  }, []);

  const [paymentData, setPaymentData] = useState<CreateQrResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // ── Mã giới thiệu ──────────────────────────────────────────────────
  const [affCode, setAffCode] = useState('');
  const [affValidation, setAffValidation] = useState<ValidateAffCodeResult | null>(null);
  const [validatingAff, setValidatingAff] = useState(false);

  const [pollCount, setPollCount] = useState(0);
  const [polling, setPolling] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckPaymentResponse | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  useEffect(() => {
    return () => { if (pollTimerRef.current) clearInterval(pollTimerRef.current); };
  }, []);

  const toggleAccount = useCallback((pageId: string) => {
    setSelectedPageIds(prev => {
      const next = new Set(prev);
      next.has(pageId) ? next.delete(pageId) : next.add(pageId);
      return next;
    });
  }, []);

  const selectAllAccounts = useCallback(() => {
    setSelectedPageIds(new Set(accountsData.map(a => a.pageId)));
  }, [accountsData]);

  const PRICE_PER_MONTH = 80000;
  const plan = PLANS.find(p => p.code === selectedPlan) || PLANS[PLANS.length - 1];
  const months = Math.round(plan.durationDays / 30);
  const originalPrice = PRICE_PER_MONTH * months * selectedPageIds.size;
  const totalPrice = plan.price * selectedPageIds.size;
  const planSaving = originalPrice - totalPrice;
  const hasDiscount = affValidation?.valid === true;
  const discountAmount = hasDiscount ? Math.round(totalPrice * 0.05) : 0;
  const finalPrice = totalPrice - discountAmount;

  // ── Step 1 → 2: Create QR ────────────────────────────────────────────────
  const handleCreateQr = useCallback(async () => {
    if (selectedPageIds.size === 0) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await createPaymentQr({
        pageIds: Array.from(selectedPageIds),
        plan: selectedPlan,
        pageId: accounts[0]?.pageId || '',
        affCode: hasDiscount ? affCode.trim() : undefined,
      });
      if (!res.success) { setCreateError(res.error || 'Không thể tạo mã QR'); return; }
      setPaymentData(res);
      setStep('qr');
    } catch (err: any) {
      setCreateError(err.message || 'Lỗi kết nối');
    } finally {
      setCreating(false);
    }
  }, [selectedPageIds, selectedPlan, accounts, affCode, hasDiscount]);

  // ── Step 2 → 3: Start polling ────────────────────────────────────────────
  const handleConfirmPayment = useCallback(() => {
    setStep('confirm');
    setPollCount(0);
    setPolling(true);
    pollCountRef.current = 0;

    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    pollTimerRef.current = setInterval(async () => {
      pollCountRef.current++;
      setPollCount(pollCountRef.current);
      if (!paymentData) return;
      try {
        const res = await checkPaymentStatus(paymentData.paymentId, accounts[0]?.pageId || '');
        setCheckResult(res);
        if (res.status === 'completed' || res.status === 'expired' || res.status === 'failed') {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setPolling(false);
          if (res.status === 'completed') onPaymentSuccess();
        }
      } catch { /* ignore */ }
      if (pollCountRef.current >= POLL_MAX) {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        setPolling(false);
      }
    }, POLL_INTERVAL);
  }, [paymentData, accounts, onPaymentSuccess]);

  const handleManualCheck = useCallback(async () => {
    if (!paymentData) return;
    setPolling(true);
    try {
      const res = await checkPaymentStatus(paymentData.paymentId, accounts[0]?.pageId || '');
      setCheckResult(res);
      if (res.status === 'completed') onPaymentSuccess();
    } catch { /* ignore */ } finally { setPolling(false); }
  }, [paymentData, accounts, onPaymentSuccess]);

  const handleBackToSelect = useCallback(() => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    setStep('select');
    setPaymentData(null);
    setCheckResult(null);
    setCreateError('');
    setPollCount(0);
    setPolling(false);
  }, []);

  // ── Validate mã giới thiệu ──────────────────────────────────────────
  const handleValidateAff = useCallback(async () => {
    if (!affCode.trim()) { setAffValidation(null); return; }
    setValidatingAff(true);
    try {
      const result = await validateAffCode(affCode);
      setAffValidation(result);
    } catch {
      setAffValidation({ valid: false, error: 'Lỗi kết nối' });
    } finally {
      setValidatingAff(false);
    }
  }, [affCode]);

  // ── Step header ──────────────────────────────────────────────────────────
  const stepIdx = STEP_ORDER.indexOf(step);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-600 rounded-2xl w-[480px] shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* ── Step Header Bar ──────────────────────────────────────────── */}
        <div className="bg-gray-900/80 border-b border-gray-700 px-5 py-3">
          <div className="flex items-center justify-between mb-2.5">
            <h3 className="text-sm font-semibold text-white">Gia hạn Premium</h3>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          {/* Steps indicator */}
          <div className="flex items-center gap-0">
            {STEP_ORDER.map((s, i) => (
              <React.Fragment key={s}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0
                    ${i < stepIdx ? 'bg-green-500 text-white' :
                      i === stepIdx ? 'bg-blue-500 text-white' :
                      'bg-gray-700 text-gray-400'}`}>
                    {i < stepIdx ? '✓' : i + 1}
                  </div>
                  <span className={`text-[11px] font-medium hidden sm:inline
                    ${i === stepIdx ? 'text-white' : i < stepIdx ? 'text-green-400' : 'text-gray-400'}`}>
                    {STEP_LABELS[s]}
                  </span>
                </div>
                {i < STEP_ORDER.length - 1 && (
                  <div className={`flex-1 h-px mx-2 ${i < stepIdx ? 'bg-green-500' : 'bg-gray-700'}`} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* ── Step Content ─────────────────────────────────────────────── */}
        <div className="px-5 py-5 space-y-4 max-h-[70vh] overflow-y-auto">

          {/* ═══ Step 1: Select accounts + plan ══════════════════════════ */}
          {step === 'select' && (
            <>
              {/* Accounts */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-400 font-medium">Chọn tài khoản cần gia hạn</span>
                  <button onClick={selectAllAccounts} className="text-[11px] text-blue-400 hover:text-blue-300">Chọn tất cả</button>
                </div>
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {accountsData.map(acc => {
                    const isSelected = selectedPageIds.has(acc.pageId);
                    const isExpired = acc.expiresAt ? new Date(acc.expiresAt) < new Date() : true;
                    const daysLeft = acc.expiresAt
                      ? Math.max(0, Math.ceil((new Date(acc.expiresAt).getTime() - Date.now()) / 86400000))
                      : 0;
                    return (
                      <button key={acc.pageId} onClick={() => toggleAccount(acc.pageId)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors
                          ${isSelected ? 'border-blue-500 bg-blue-500/10' : 'border-gray-600 hover:border-gray-500'}`}>
                        <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-colors
                          ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-600 bg-gray-800'}`}>
                          {isSelected && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                        </div>
                        {acc.avatar ? (
                          <img src={acc.avatar} className="w-8 h-8 rounded-full object-cover flex-shrink-0" alt="" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                            {(acc.pageId || '?').charAt(0)}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate font-medium">{acc.displayName || acc.pageId}</p>
                          <p className={`text-[11px] ${isExpired ? 'text-red-400' : 'text-gray-400'}`}>
                            {acc.expiresAt
                              ? (isExpired ? 'Đã hết hạn' : `Còn ${daysLeft} ngày · Hết hạn: ${new Date(acc.expiresAt).toLocaleDateString('vi-VN')}`)
                              : 'Chưa có Premium'}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Plans */}
              <div>
                <span className="text-xs text-gray-400 font-medium block mb-2">Chọn gói gia hạn</span>
                <div className="grid grid-cols-2 gap-2">
                  {PLANS.map(p => {
                    const orig = PRICE_PER_MONTH * Math.round(p.durationDays / 30);
                    const save = orig - p.price;
                    const savePercent = Math.round((save / orig) * 100);
                    return (
                      <button key={p.code} onClick={() => setSelectedPlan(p.code)}
                        className={`px-3 py-3 rounded-lg border text-center transition-colors relative
                          ${selectedPlan === p.code ? 'border-green-500 bg-green-500/10' : 'border-gray-600 hover:border-gray-500'}`}>
                        <span className="absolute -top-2 right-0 -translate-x-1/2 px-2 py-0.5 bg-red-500 text-white text-[11px] font-bold rounded-full leading-none whitespace-nowrap">
                          -{savePercent}%
                        </span>
                        <p className="text-xs text-white font-bold">{p.name}</p>
                        <p className="text-[12px] text-gray-300 line-through mt-1">{formatCurrency(orig)}</p>
                        <p className="text-[14px] text-green-400 font-bold">{formatCurrency(p.price)}</p>
                        <p className="text-[10px] text-gray-300 mt-0.5">Tiết kiệm {formatCurrency(save)}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── Mã giới thiệu ──────────────────────────────────────── */}
              <div>
                <span className="text-xs text-gray-400 font-medium block mb-2">Mã giới thiệu (tùy chọn)</span>
                <div className="flex items-center gap-2">
                  <input
                    value={affCode}
                    onChange={e => { setAffCode(e.target.value); setAffValidation(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') handleValidateAff(); }}
                    placeholder="Nhập mã để được giảm 5%"
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleValidateAff}
                    disabled={!affCode.trim() || validatingAff}
                    className="px-3 py-2 text-xs font-medium rounded-lg bg-gray-600 hover:bg-gray-500 text-gray-200 transition-colors disabled:opacity-40 flex-shrink-0"
                  >
                    {validatingAff ? '...' : 'Áp dụng'}
                  </button>
                </div>
                {affValidation && (
                  <div className={`mt-2 px-3 py-2 rounded-lg text-xs flex items-center gap-2
                    ${affValidation.valid ? 'bg-green-500/10 border border-green-500/30 text-green-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
                    {affValidation.valid ? (
                      <>✅ Mã hợp lệ: <span className="font-medium">{affValidation.name}</span> — Giảm 5%</>
                    ) : (
                      <>❌ {affValidation.error || 'Mã không hợp lệ'}</>
                    )}
                  </div>
                )}
              </div>

              {/* Total */}
              {selectedPageIds.size > 0 && (
                <div className="bg-gray-700/50 rounded-lg px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-400">Giá gốc ({selectedPageIds.size} TK × {formatCurrency(PRICE_PER_MONTH)}/tháng × {months} tháng)</span>
                    <span className="text-gray-400 line-through">{formatCurrency(originalPrice)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-green-400">Ưu đãi gói {plan.name}</span>
                    <span className="text-green-400">-{formatCurrency(planSaving)}</span>
                  </div>
                  {hasDiscount && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-green-400">Mã giới thiệu giảm 5%</span>
                      <span className="text-green-400">-{formatCurrency(discountAmount)}</span>
                    </div>
                  )}
                  <div className="border-t border-gray-600 pt-2 flex items-center justify-between">
                    <span className="text-sm text-gray-300 font-medium">Thanh toán</span>
                    <span className={`text-lg font-bold ${hasDiscount ? 'text-green-400' : 'text-white'}`}>{formatCurrency(finalPrice)}</span>
                  </div>
                </div>
              )}

              {createError && (
                <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400 flex items-center gap-2">
                  {AlertIcon} {createError}
                </div>
              )}

              <button onClick={handleCreateQr} disabled={selectedPageIds.size === 0 || creating}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2">
                {creating ? <>{SpinIcon} Đang tạo mã QR...</> : 'Tiếp tục →'}
              </button>
            </>
          )}

          {/* ═══ Step 2: QR Code ═════════════════════════════════════════ */}
          {step === 'qr' && paymentData && (
            <>
              <div className="flex flex-col items-center bg-white rounded-xl p-4 mx-auto" style={{ maxWidth: 260 }}>
                <img src={paymentData.qrCodeUrl} alt="QR Code" className="w-full h-auto" />
              </div>

              <div className="bg-gray-700/50 rounded-lg p-3 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-400">Ngân hàng</span><span className="text-white font-medium">{paymentData.bankInfo.bankName}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Số TK</span><span className="text-white font-medium">{paymentData.bankInfo.accountNumber}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Chủ TK</span><span className="text-white font-medium">{paymentData.bankInfo.accountName}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Nội dung CK</span><span className="text-yellow-400 font-mono font-medium text-xs">{paymentData.transferContent}</span></div>
                <div className="border-t border-gray-600 pt-2 space-y-1">
                  {paymentData.discount ? (
                    <>
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Gốc</span>
                        <span className="text-gray-400 line-through">{formatCurrency(paymentData.originalAmount || 0)}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-green-400">Giảm 5%</span>
                        <span className="text-green-400">-{formatCurrency(paymentData.discount)}</span>
                      </div>
                    </>
                  ) : null}
                  <div className="flex justify-between">
                    <span className="text-gray-400">Số tiền</span>
                    <span className={`font-bold text-lg ${paymentData.discount ? 'text-green-400' : 'text-white'}`}>{formatCurrency(paymentData.amount)}</span>
                  </div>
                </div>
              </div>

              <p className="text-[11px] text-gray-500 text-center">⚠️ Chuyển khoản đúng số tiền và nội dung CK</p>

              <div className="flex gap-2">
                <button onClick={handleBackToSelect} className="flex-1 py-2.5 rounded-lg bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">← Quay lại</button>
                <button onClick={handleConfirmPayment} className="flex-1 py-2.5 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-semibold flex items-center justify-center gap-2">
                  {CheckIcon} Đã chuyển khoản
                </button>
              </div>
            </>
          )}

          {/* ═══ Step 3: Confirm / Polling ════════════════════════════════ */}
          {step === 'confirm' && (
            <>
              {polling && (
                <div className="flex flex-col items-center py-6 space-y-3">
                  <div className="w-10 h-10 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">{SpinIcon}</div>
                  <div className="text-center">
                    <p className="text-sm text-white font-medium">Đang kiểm tra thanh toán, vui lòng chờ ít giây...</p>
                  </div>
                  <div className="w-48 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${(pollCount / POLL_MAX) * 100}%` }} />
                  </div>
                </div>
              )}

              {checkResult?.status === 'completed' && (
                <div className="flex flex-col items-center py-6 space-y-3">
                  <div className="w-10 h-10 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center text-green-400">{CheckIcon}</div>
                  <div className="text-center">
                    <p className="text-sm text-green-400 font-semibold">Thanh toán thành công!</p>
                    {checkResult.updatedAccounts?.map(acc => (
                      <p key={acc.pageId} className="text-[11px] text-gray-400 mt-1">
                        <span className="text-white">{acc.pageId}</span> → hạn mới: {new Date(acc.premiumExpiresAt).toLocaleDateString('vi-VN')}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {checkResult?.status === 'expired' && (
                <div className="px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-xs text-yellow-400 flex items-center gap-2">
                  {AlertIcon} Đơn hàng đã hết hạn. Vui lòng tạo đơn mới.
                </div>
              )}

              {!polling && checkResult?.status === 'pending' && (
                <div className="px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-xs text-yellow-400 flex items-center gap-2">
                  {AlertIcon} Chưa phát hiện giao dịch. Có thể ngân hàng đang xử lý chậm. Vui lòng liên hệ <a href={'https://t.me/babyvibe9'}>Admin</a> để được hỗ trợ
                </div>
              )}

              {!polling && checkResult?.status !== 'completed' && (
                <div className="flex gap-2">
                  <button onClick={handleBackToSelect} className="flex-1 py-2.5 rounded-lg bg-gray-700 text-gray-300 text-sm">← Quay lại</button>
                  <button onClick={handleManualCheck} className="flex-1 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium flex items-center justify-center gap-2">
                    {RefreshIcon} Cập nhật trạng thái
                  </button>
                </div>
              )}

              {checkResult?.status === 'completed' && (
                <button onClick={onClose} className="w-full py-2.5 rounded-lg bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">Đóng</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
