/**
 * Settings → Security: lock the screen with a password. Not enabled: set a password. Enabled: three inline rows (change password, view the
 * recovery code, turn the lock off) instead of the abbreviated tab. After enabling, the recovery code is shown once and the user must confirm it was saved.
 */
import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { ChevronDownIcon, HashIcon, KeyIcon, LockIcon, ShieldIcon } from '@/components/common/icons';
import { Button, Input } from '@/components/ui';
import { Notice, SettingsPage, SettingsSection } from '../settingsUi';
import { tr } from '../../../../shared/i18n';

type Tab = 'security' | 'recovery' | 'disable';

const PAGE_DESCRIPTION = tr('Khoá Deplao bằng mật khẩu khi mở app hoặc khi bạn rời máy.');

function StatusPill({ on }: { on: boolean }) {
  return (
    <span className={cn(
      'flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
      on ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
    )}>
      {on ? tr('Đã bật') : tr('Chưa bật')}
    </span>
  );
}

/** Recovery code: large text, the whole string can be selected, with a copy button. */
function RecoveryKeyBox({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted px-4 py-3">
      <p className="min-w-0 flex-1 select-all break-all font-mono text-base font-bold tracking-widest text-foreground">{value}</p>
      <Button variant="outline" size="sm" onClick={onCopy}>{tr('Sao chép')}</Button>
    </div>
  );
}

/** One inline row inside the "Khoá màn hình" (Screen lock) block. */
function ExpandLine({ icon, title, description, open, onToggle, danger, children }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted">
        <span className={cn('flex-shrink-0', danger ? 'text-destructive' : 'text-muted-foreground')}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cn('block text-sm font-medium', danger ? 'text-destructive' : 'text-foreground')}>{title}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
        <ChevronDownIcon className={cn('h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="max-w-sm space-y-3 pb-4 pl-9 pt-1">{children}</div>}
    </div>
  );
}

export default function LockScreenSettings() {
  const [enabled, setEnabled] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [savedRecoveryKey, setSavedRecoveryKey] = useState('');
  const [keySavedConfirm, setKeySavedConfirm] = useState(false);
  // Recovery key viewing state
  const [recoveryView, setRecoveryView] = useState<'idle' | 'show'>('idle');

  // Load status on mount
  useEffect(() => {
    ipc.lockScreen.status().then(res => {
      if (res.success) {
        setEnabled(res.enabled);
      }
    });
  }, []);

  const clearMessages = () => { setError(''); setSuccess(''); };

  // ─── Setup password ───────────────────────────────────────────────────────
  const handleSetup = useCallback(async () => {
    clearMessages();
    if (password.length < 4) {
      setError(tr('Mật khẩu phải có ít nhất 4 ký tự'));
      return;
    }
    if (password !== confirmPassword) {
      setError(tr('Mật khẩu xác nhận không khớp'));
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.setup({ password });
      if (res.success) {
        setSavedRecoveryKey(res.recoveryKey || '');
        setEnabled(true);
        setPassword('');
        setConfirmPassword('');
        // Show recovery key inline
        setRecoveryView('show');
        // Notify App.tsx + TopBar to enable keyboard shortcut & lock icon
        window.dispatchEvent(new CustomEvent('lockScreen:changed', { detail: { enabled: true } }));
      } else {
        setError(res.error || tr('Lỗi thiết lập mật khẩu'));
      }
    } catch {
      setError(tr('Lỗi kết nối'));
    } finally {
      setLoading(false);
    }
  }, [password, confirmPassword]);

  // ─── Change password ─────────────────────────────────────────────────────
  const handleChangePassword = useCallback(async () => {
    clearMessages();
    if (!oldPassword.trim()) {
      setError(tr('Vui lòng nhập mật khẩu hiện tại'));
      return;
    }
    if (newPassword.length < 4) {
      setError(tr('Mật khẩu mới phải có ít nhất 4 ký tự'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(tr('Mật khẩu xác nhận không khớp'));
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.changePassword({ oldPassword, newPassword });
      if (res.success) {
        setSuccess(tr('Đổi mật khẩu thành công'));
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setError(res.error || tr('Đổi mật khẩu thất bại'));
      }
    } catch {
      setError(tr('Lỗi kết nối'));
    } finally {
      setLoading(false);
    }
  }, [oldPassword, newPassword, confirmPassword]);

  // ─── Disable lock screen ─────────────────────────────────────────────────
  const handleDisable = useCallback(async () => {
    clearMessages();
    if (!password.trim()) {
      setError(tr('Vui lòng nhập mật khẩu để tắt khoá'));
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.disable({ password });
      if (res.success) {
        setEnabled(false);
        setPassword('');
        setTab(null);
        setSuccess(tr('Đã tắt khoá màn hình'));
        // Notify App.tsx + TopBar to disable keyboard shortcut & lock icon
        window.dispatchEvent(new CustomEvent('lockScreen:changed', { detail: { enabled: false } }));
      } else {
        setError(res.error || tr('Mật khẩu không đúng'));
      }
    } catch {
      setError(tr('Lỗi kết nối'));
    } finally {
      setLoading(false);
    }
  }, [password]);

  // ─── Show recovery key ───────────────────────────────────────────────────
  const handleShowRecovery = useCallback(async () => {
    clearMessages();
    if (!password.trim()) {
      setError(tr('Vui lòng nhập mật khẩu'));
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.getRecoveryKey({ password });
      if (res.success && res.recoveryKey) {
        setRecoveryKey(res.recoveryKey);
        setRecoveryView('show');
        setPassword('');
      } else {
        setError(res.error || tr('Mật khẩu không đúng'));
      }
    } catch {
      setError(tr('Lỗi kết nối'));
    } finally {
      setLoading(false);
    }
  }, [password]);

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setSuccess(tr('Đã sao chép mã khôi phục'));
  };

  /** Open / close a row; only one row is open at a time. Switching rows clears the password field and the notice. */
  const toggleLine = (id: Tab) => {
    setTab(prev => (prev === id ? null : id));
    clearMessages();
    setRecoveryView('idle');
    setRecoveryKey('');
    setPassword('');
  };

  const messages = (
    <>
      {error && <Notice tone="destructive"><p role="alert">{error}</p></Notice>}
      {success && <Notice tone="success"><p>{success}</p></Notice>}
    </>
  );

  const showPasswordToggle = (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} className="rounded accent-primary" />
      {tr('Hiện mật khẩu')}
    </label>
  );

  // ─── Just enabled: show the recovery code once ─────────────────────────────────
  if (enabled && savedRecoveryKey && recoveryView === 'show' && !recoveryKey) {
    return (
      <SettingsPage title={tr('Bảo mật')} description={PAGE_DESCRIPTION}>
        <SettingsSection title={tr('Khoá màn hình đã bật')} flush bodyClassName="space-y-4 p-4">
          <p className="text-sm text-foreground">
            {tr('Lưu mã khôi phục dưới đây ở nơi an toàn. Quên mật khẩu thì cần mã này để mở lại.')}
          </p>
          <RecoveryKeyBox value={savedRecoveryKey} onCopy={() => handleCopyKey(savedRecoveryKey)} />
          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
            <input type="checkbox" checked={keySavedConfirm} onChange={e => setKeySavedConfirm(e.target.checked)} className="mt-0.5 rounded accent-primary" />
            <span>{tr('Tôi đã lưu mã khôi phục')}</span>
          </label>
          <div className="flex justify-end">
            <Button
              disabled={!keySavedConfirm}
              onClick={() => {
                setSavedRecoveryKey('');
                setKeySavedConfirm(false);
                setRecoveryView('idle');
                setSuccess('');
              }}
            >
              {tr('Hoàn tất')}
            </Button>
          </div>
        </SettingsSection>
        {success && <Notice tone="success"><p>{success}</p></Notice>}
      </SettingsPage>
    );
  }

  // ─── Not enabled: set a password ─────────────────────────────────────────────
  if (!enabled) {
    return (
      <SettingsPage title={tr('Bảo mật')} description={PAGE_DESCRIPTION}>
        <SettingsSection flush bodyClassName="p-4">
          <div className="flex items-start gap-3">
            <ShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{tr('Khoá màn hình')}</p>
              <p className="text-xs text-muted-foreground">{tr('Đặt mật khẩu để bật. Tối thiểu 4 ký tự.')}</p>
            </div>
            <StatusPill on={false} />
          </div>
          <div className="mt-4 max-w-sm space-y-3 pl-8">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => { setPassword(e.target.value); clearMessages(); }}
              placeholder={tr('Mật khẩu')}
              aria-label={tr('Mật khẩu')}
            />
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); clearMessages(); }}
              onKeyDown={e => { if (e.key === 'Enter') void handleSetup(); }}
              placeholder={tr('Nhập lại mật khẩu')}
              aria-label={tr('Nhập lại mật khẩu')}
            />
            {showPasswordToggle}
            <Button onClick={handleSetup} disabled={loading || !password.trim()}>
              {loading ? tr('Đang bật...') : tr('Bật khoá màn hình')}
            </Button>
          </div>
        </SettingsSection>
        {messages}
      </SettingsPage>
    );
  }

  // ─── Enabled: three inline rows ────────────────────────────────────────
  return (
    <SettingsPage title={tr('Bảo mật')} description={PAGE_DESCRIPTION}>
      <SettingsSection>
        <div className="flex items-start gap-3 py-3">
          <ShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{tr('Khoá màn hình')}</p>
            <p className="text-xs text-muted-foreground">{tr('Cần mật khẩu mỗi khi mở Deplao.')}</p>
          </div>
          <StatusPill on />
        </div>

        <ExpandLine icon={<KeyIcon className="h-4 w-4" />} title={tr('Đổi mật khẩu')} description={tr('Cần mật khẩu hiện tại.')}
          open={tab === 'security'} onToggle={() => toggleLine('security')}>
          <Input type={showPassword ? 'text' : 'password'} value={oldPassword} aria-label={tr('Mật khẩu hiện tại')}
            onChange={e => { setOldPassword(e.target.value); clearMessages(); }} placeholder={tr('Mật khẩu hiện tại')} />
          <Input type={showPassword ? 'text' : 'password'} value={newPassword} aria-label={tr('Mật khẩu mới')}
            onChange={e => { setNewPassword(e.target.value); clearMessages(); }} placeholder={tr('Mật khẩu mới (tối thiểu 4 ký tự)')} />
          <Input type={showPassword ? 'text' : 'password'} value={confirmPassword} aria-label={tr('Nhập lại mật khẩu mới')}
            onChange={e => { setConfirmPassword(e.target.value); clearMessages(); }}
            onKeyDown={e => { if (e.key === 'Enter') void handleChangePassword(); }}
            placeholder={tr('Nhập lại mật khẩu mới')} />
          {showPasswordToggle}
          <Button onClick={handleChangePassword} disabled={loading}>{loading ? tr('Đang xử lý...') : tr('Đổi mật khẩu')}</Button>
          {messages}
        </ExpandLine>

        <ExpandLine icon={<HashIcon className="h-4 w-4" />} title={tr('Mã khôi phục')} description={tr('Dùng khi quên mật khẩu. Nhập mật khẩu để xem.')}
          open={tab === 'recovery'} onToggle={() => toggleLine('recovery')}>
          {recoveryKey && recoveryView === 'show' ? (
            <>
              <RecoveryKeyBox value={recoveryKey} onCopy={() => handleCopyKey(recoveryKey)} />
              <p className="text-xs text-muted-foreground">{tr('Giữ mã này ở nơi an toàn, không chia sẻ cho người khác.')}</p>
            </>
          ) : (
            <>
              <Input type="password" value={password} aria-label={tr('Mật khẩu')}
                onChange={e => { setPassword(e.target.value); clearMessages(); }}
                onKeyDown={e => { if (e.key === 'Enter') void handleShowRecovery(); }}
                placeholder={tr('Mật khẩu')} />
              <Button variant="outline" onClick={handleShowRecovery} disabled={loading}>{loading ? tr('Đang xử lý...') : tr('Xem mã khôi phục')}</Button>
            </>
          )}
          {messages}
        </ExpandLine>

        <ExpandLine icon={<LockIcon className="h-4 w-4" />} title={tr('Tắt khoá màn hình')} description={tr('Không cần mật khẩu khi mở app nữa.')}
          open={tab === 'disable'} onToggle={() => toggleLine('disable')} danger>
          <Input type="password" value={password} aria-label={tr('Mật khẩu')}
            onChange={e => { setPassword(e.target.value); clearMessages(); }}
            onKeyDown={e => { if (e.key === 'Enter') void handleDisable(); }}
            placeholder={tr('Mật khẩu để tắt')} />
          <Button variant="destructive" onClick={handleDisable} disabled={loading}>{loading ? tr('Đang xử lý...') : tr('Tắt khoá màn hình')}</Button>
          {messages}
        </ExpandLine>
      </SettingsSection>
      {/* Notice shown when no row is open (e.g. right after turning the lock off) */}
      {!tab && messages}
    </SettingsPage>
  );
}
