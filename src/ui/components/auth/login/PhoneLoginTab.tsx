/**
 * PhoneLoginTab.tsx - UI đăng nhập Telegram cá nhân qua số điện thoại
 *
 * 3 bước:
 * 1. Nhập số điện thoại → gửi mã OTP
 * 2. Nhập mã OTP → xác nhận
 * 3. (Nếu có 2FA) Nhập mật khẩu cloud
 */

import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { createDefaultLabels } from '@/lib/labels/defaultLabels';
import { Spinner } from '@/components/common/PageLoading';
import { CheckIcon, AlertIcon, SmartphoneIcon } from '@/components/common/icons';

interface Props {
  onSuccess: () => void;
  onBack: () => void;
}

type LoginStep = 'phone' | 'code' | 'password' | 'done';

export default function PhoneLoginTab({ onSuccess, onBack }: Props) {
  const [step, setStep] = useState<LoginStep>('phone');
  const [phoneNumber, setPhoneNumber] = useState(''); // raw input (digits only, no country code)
  const [countryCode, setCountryCode] = useState('+84');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { showNotification } = useAppStore();
  const addAccount = useAccountStore(s => s.addAccount);

  // Bước 1: Gửi mã OTP
  const handleSendCode = async () => {
    if (!phoneNumber.trim()) {
      setError('Vui lòng nhập số điện thoại');
      return;
    }
    // Normalize phone number
    const phone = countryCode + phoneNumber.trim().replace(/^0/, '');

    setLoading(true);
    setError('');

    try {
      const res = await ipc.telegramUser?.sendCode(phone);
      if (res?.success && res.phoneCodeHash) {
        setPhoneCodeHash(res.phoneCodeHash);
        setStep('code');
      } else {
        setError(res?.error || 'Không thể gửi mã OTP');
      }
    } catch (err: any) {
      setError(err.message || 'Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  };

  // Bước 2: Xác nhận mã OTP
  const handleSignIn = async () => {
    if (!code.trim()) {
      setError('Vui lòng nhập mã OTP');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await ipc.telegramUser?.signIn({
        phoneNumber: countryCode + phoneNumber.trim().replace(/^0/, ''),
        code: code.trim(),
        phoneCodeHash,
      });

      if (res?.success && res.stringSession && res.accountId) {
        // Login thành công
        await handleLoginSuccess(res.accountId, res.stringSession, res.userInfo);
      } else if (res?.error === '2FA_REQUIRED') {
        setStep('password');
      } else {
        setError(res?.error || 'Mã OTP không đúng');
      }
    } catch (err: any) {
      setError(err.message || 'Lỗi xác nhận');
    } finally {
      setLoading(false);
    }
  };

  // Bước 3: Xác nhận 2FA
  const handleSignIn2FA = async () => {
    if (!password.trim()) {
      setError('Vui lòng nhập mật khẩu');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await ipc.telegramUser?.signIn2FA(password.trim());

      if (res?.success && res.stringSession && res.accountId) {
        await handleLoginSuccess(res.accountId, res.stringSession, res.userInfo);
      } else {
        setError(res?.error || 'Mật khẩu không đúng');
      }
    } catch (err: any) {
      setError(err.message || 'Lỗi xác nhận 2FA');
    } finally {
      setLoading(false);
    }
  };

  // Xử lý sau khi login thành công
  const handleLoginSuccess = async (accountId: string, stringSession: string, userInfo?: any) => {
    const fullPhone = countryCode + phoneNumber.trim().replace(/^0/, '');
    const fullName = userInfo?.firstName
      ? `${userInfo.firstName} ${userInfo.lastName || ''}`.trim()
      : `Telegram ${fullPhone}`;
    const username = userInfo?.username || '';

    // Add account to store
    addAccount({
      zalo_id: accountId,
      full_name: fullName,
      avatar_url: '',
      phone: fullPhone,
      username,
      imei: '',
      cookies: stringSession, // Lưu StringSession vào cookies column
      user_agent: '',
      channel: 'telegram_user',
    } as any);

    // Save to database via IPC (persist across restarts)
    try {
      await ipc.db?.saveAccount?.({
        zalo_id: accountId,
        full_name: fullName,
        avatar_url: '',
        phone: fullPhone,
        username,
        imei: '',
        cookies: stringSession,
        user_agent: '',
        is_active: 1,
        created_at: new Date().toISOString(),
        channel: 'telegram_user',
      } as any);
    } catch (e) {
      console.warn('[PhoneLoginTab] Failed to save account to DB:', e);
    }

    // Create default labels for new Telegram User account
    await createDefaultLabels(accountId);

    // Start MTProto listener
    const listenerRes = await ipc.telegramUser?.startListener({
      accountId,
      phoneNumber: fullPhone,
      stringSession,
    });

    // Fetch self avatar sau khi listener kết nối thành công
    if (listenerRes?.success) {
      try {
        const avatarRes = await (ipc as any).telegramUser?.fetchSelfAvatar?.(accountId);
        if (avatarRes?.success && avatarRes.avatarUrl) {
          useAccountStore.getState().updateAccount(accountId, { avatar_url: avatarRes.avatarUrl });
          // Cập nhật luôn vào DB
          await ipc.db?.updateContactProfile?.({ zaloId: accountId, contactId: accountId, displayName: fullName, avatarUrl: avatarRes.avatarUrl });
        }
      } catch { /* fire-and-forget */ }
    }

    showNotification('Đăng nhập Telegram thành công!', 'success');
    setStep('done');
    setTimeout(onSuccess, 1500);
  };

  return (
    <div className="p-6 space-y-4">
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-4">
        {['phone', 'code', 'password'].map((s, i) => (
          <React.Fragment key={s}>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
              step === s ? 'bg-blue-600 text-white' :
              (step === 'done' || ['phone', 'code', 'password'].indexOf(step) > i) ? 'bg-green-600 text-white' :
              'bg-muted text-muted-foreground'
            }`}>
              {(['phone', 'code', 'password'].indexOf(step) > i || step === 'done') ? <CheckIcon className="w-4 h-4" /> : i + 1}
            </div>
            {i < 2 && <div className={`flex-1 h-0.5 ${(['phone', 'code', 'password'].indexOf(step) > i || step === 'done') ? 'bg-green-600' : 'bg-muted'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Bước 1: Nhập SĐT */}
      {step === 'phone' && (
        <>
          <div className="bg-blue-900/20 border border-blue-700/30 rounded-xl p-4">
            <p className="text-blue-300 text-xs font-semibold mb-2">📱 Đăng nhập Telegram cá nhân</p>
            <p className="text-blue-400 text-[11px] leading-relaxed">
              Nhập số điện thoại đã đăng ký Telegram. Mã OTP sẽ được gửi đến ứng dụng Telegram trên điện thoại của bạn.
            </p>
          </div>

          <div>
            <label className="text-foreground/80 text-xs font-medium mb-1.5 block">Số điện thoại</label>
            <div className="relative">
              <select
                value={countryCode}
                onChange={e => setCountryCode(e.target.value)}
                className="absolute left-0 top-0 bottom-0 bg-accent border-r border-border-strong rounded-l-lg px-2 text-sm text-foreground focus:outline-none"
              >
                <option value="+84">+84</option>
                <option value="+1">+1</option>
                <option value="+44">+44</option>
                <option value="+86">+86</option>
                <option value="+81">+81</option>
                <option value="+82">+82</option>
              </select>
              <input
                type="tel"
                value={phoneNumber}
                onChange={e => setPhoneNumber(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="901234567"
                className="w-full bg-muted border border-input rounded-lg pl-16 pr-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors"
                disabled={loading}
              />
            </div>
          </div>
        </>
      )}

      {/* Bước 2: Nhập mã OTP */}
      {step === 'code' && (
        <>
          <div className="bg-green-900/20 border border-green-700/30 rounded-xl p-4">
            <p className="text-green-300 text-xs font-semibold mb-2">✉️ Kiểm tra Telegram</p>
            <p className="text-green-400 text-[11px] leading-relaxed">
              Mã OTP đã được gửi đến ứng dụng Telegram của bạn. Nhập mã gồm 5 chữ số bên dưới.
            </p>
          </div>

          <div>
            <label className="text-foreground/80 text-xs font-medium mb-1.5 block">Mã OTP</label>
            <input
              type="text"
              value={code}
              onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
              placeholder="12345"
              maxLength={5}
              className="w-full bg-muted border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors text-center text-lg tracking-widest"
              disabled={loading}
              autoFocus
            />
          </div>
        </>
      )}

      {/* Bước 3: Nhập 2FA */}
      {step === 'password' && (
        <>
          <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
            <p className="text-yellow-300 text-xs font-semibold mb-2">🔒 Xác thực 2 lớp</p>
            <p className="text-yellow-400 text-[11px] leading-relaxed">
              Tài khoản Telegram của bạn có bật xác thực 2 lớp. Nhập mật khẩu cloud password.
            </p>
          </div>

          <div>
            <label className="text-foreground/80 text-xs font-medium mb-1.5 block">Mật khẩu</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Nhập mật khẩu 2FA"
              className="w-full bg-muted border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors"
              disabled={loading}
              autoFocus
            />
          </div>
        </>
      )}

      {/* Done */}
      {step === 'done' && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="w-16 h-16 rounded-full bg-green-600/30 flex items-center justify-center">
            <CheckIcon className="w-8 h-8 text-green-400" />
          </div>
          <p className="text-green-300 text-sm font-semibold">Đăng nhập thành công!</p>
          <p className="text-muted-foreground text-xs">Đang khởi động listener...</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs">
          <AlertIcon className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={step === 'phone' ? onBack : () => { setStep('phone'); setError(''); }}
          className="flex-1 px-4 py-2.5 bg-muted hover:bg-accent text-foreground/80 text-sm rounded-lg transition-colors"
        >
          {step === 'phone' ? 'Quay lại' : 'Sửa SĐT'}
        </button>

        {step === 'phone' && (
          <button
            onClick={handleSendCode}
            disabled={!phoneNumber.trim() || loading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? <><Spinner size={4} /> Đang gửi...</> : 'Gửi mã OTP'}
          </button>
        )}

        {step === 'code' && (
          <button
            onClick={handleSignIn}
            disabled={code.length < 5 || loading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? <><Spinner size={4} /> Đang xác nhận...</> : 'Xác nhận'}
          </button>
        )}

        {step === 'password' && (
          <button
            onClick={handleSignIn2FA}
            disabled={!password.trim() || loading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {loading ? <><Spinner size={4} /> Đang xác nhận...</> : 'Xác nhận'}
          </button>
        )}
      </div>
    </div>
  );
}
