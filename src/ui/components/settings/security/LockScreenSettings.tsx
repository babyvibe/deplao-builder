/**
 * Cài đặt → Bảo mật: khoá màn hình bằng mật khẩu. Chưa bật: đặt mật khẩu. Đã bật: ba dòng mở tại chỗ (đổi mật khẩu, xem mã
 * khôi phục, tắt khoá) thay cho tab viết tắt. Bật xong hiện mã khôi phục một lần, phải xác nhận đã lưu.
 */
import React, { useState, useEffect, useCallback } from 'react';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { ChevronDownIcon, HashIcon, KeyIcon, LockIcon, ShieldIcon } from '@/components/common/icons';
import { Button, Input } from '@/components/ui';
import { Notice, SettingsPage, SettingsSection } from '../settingsUi';

type Tab = 'security' | 'recovery' | 'disable';

const PAGE_DESCRIPTION = 'Khoá Deplao bằng mật khẩu khi mở app hoặc khi bạn rời máy.';

function StatusPill({ on }: { on: boolean }) {
  return (
    <span className={cn(
      'flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
      on ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
    )}>
      {on ? 'Đã bật' : 'Chưa bật'}
    </span>
  );
}

/** Mã khôi phục: chữ lớn, chọn được cả chuỗi, nút sao chép. */
function RecoveryKeyBox({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted px-4 py-3">
      <p className="min-w-0 flex-1 select-all break-all font-mono text-base font-bold tracking-widest text-foreground">{value}</p>
      <Button variant="outline" size="sm" onClick={onCopy}>Sao chép</Button>
    </div>
  );
}

/** Một dòng mở tại chỗ trong khối "Khoá màn hình". */
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
      setError('Mật khẩu phải có ít nhất 4 ký tự');
      return;
    }
    if (password !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
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
        setError(res.error || 'Lỗi thiết lập mật khẩu');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [password, confirmPassword]);

  // ─── Change password ─────────────────────────────────────────────────────
  const handleChangePassword = useCallback(async () => {
    clearMessages();
    if (!oldPassword.trim()) {
      setError('Vui lòng nhập mật khẩu hiện tại');
      return;
    }
    if (newPassword.length < 4) {
      setError('Mật khẩu mới phải có ít nhất 4 ký tự');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.changePassword({ oldPassword, newPassword });
      if (res.success) {
        setSuccess('Đổi mật khẩu thành công');
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setError(res.error || 'Đổi mật khẩu thất bại');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [oldPassword, newPassword, confirmPassword]);

  // ─── Disable lock screen ─────────────────────────────────────────────────
  const handleDisable = useCallback(async () => {
    clearMessages();
    if (!password.trim()) {
      setError('Vui lòng nhập mật khẩu để tắt khoá');
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.lockScreen.disable({ password });
      if (res.success) {
        setEnabled(false);
        setPassword('');
        setTab(null);
        setSuccess('Đã tắt khoá màn hình');
        // Notify App.tsx + TopBar to disable keyboard shortcut & lock icon
        window.dispatchEvent(new CustomEvent('lockScreen:changed', { detail: { enabled: false } }));
      } else {
        setError(res.error || 'Mật khẩu không đúng');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [password]);

  // ─── Show recovery key ───────────────────────────────────────────────────
  const handleShowRecovery = useCallback(async () => {
    clearMessages();
    if (!password.trim()) {
      setError('Vui lòng nhập mật khẩu');
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
        setError(res.error || 'Mật khẩu không đúng');
      }
    } catch {
      setError('Lỗi kết nối');
    } finally {
      setLoading(false);
    }
  }, [password]);

  const handleCopyKey = (key: string) => {
    navigator.clipboard.writeText(key);
    setSuccess('Đã sao chép mã khôi phục');
  };

  /** Mở / đóng một dòng; mỗi lúc một dòng, đổi dòng thì xoá ô mật khẩu và thông báo. */
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
      Hiện mật khẩu
    </label>
  );

  // ─── Vừa bật: hiện mã khôi phục một lần ─────────────────────────────────
  if (enabled && savedRecoveryKey && recoveryView === 'show' && !recoveryKey) {
    return (
      <SettingsPage title="Bảo mật" description={PAGE_DESCRIPTION}>
        <SettingsSection title="Khoá màn hình đã bật" flush bodyClassName="space-y-4 p-4">
          <p className="text-sm text-foreground">
            Lưu mã khôi phục dưới đây ở nơi an toàn. Quên mật khẩu thì cần mã này để mở lại.
          </p>
          <RecoveryKeyBox value={savedRecoveryKey} onCopy={() => handleCopyKey(savedRecoveryKey)} />
          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
            <input type="checkbox" checked={keySavedConfirm} onChange={e => setKeySavedConfirm(e.target.checked)} className="mt-0.5 rounded accent-primary" />
            <span>Tôi đã lưu mã khôi phục</span>
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
              Hoàn tất
            </Button>
          </div>
        </SettingsSection>
        {success && <Notice tone="success"><p>{success}</p></Notice>}
      </SettingsPage>
    );
  }

  // ─── Chưa bật: đặt mật khẩu ─────────────────────────────────────────────
  if (!enabled) {
    return (
      <SettingsPage title="Bảo mật" description={PAGE_DESCRIPTION}>
        <SettingsSection flush bodyClassName="p-4">
          <div className="flex items-start gap-3">
            <ShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Khoá màn hình</p>
              <p className="text-xs text-muted-foreground">Đặt mật khẩu để bật. Tối thiểu 4 ký tự.</p>
            </div>
            <StatusPill on={false} />
          </div>
          <div className="mt-4 max-w-sm space-y-3 pl-8">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => { setPassword(e.target.value); clearMessages(); }}
              placeholder="Mật khẩu"
              aria-label="Mật khẩu"
            />
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => { setConfirmPassword(e.target.value); clearMessages(); }}
              onKeyDown={e => { if (e.key === 'Enter') void handleSetup(); }}
              placeholder="Nhập lại mật khẩu"
              aria-label="Nhập lại mật khẩu"
            />
            {showPasswordToggle}
            <Button onClick={handleSetup} disabled={loading || !password.trim()}>
              {loading ? 'Đang bật...' : 'Bật khoá màn hình'}
            </Button>
          </div>
        </SettingsSection>
        {messages}
      </SettingsPage>
    );
  }

  // ─── Đã bật: ba dòng mở tại chỗ ────────────────────────────────────────
  return (
    <SettingsPage title="Bảo mật" description={PAGE_DESCRIPTION}>
      <SettingsSection>
        <div className="flex items-start gap-3 py-3">
          <ShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Khoá màn hình</p>
            <p className="text-xs text-muted-foreground">Cần mật khẩu mỗi khi mở Deplao.</p>
          </div>
          <StatusPill on />
        </div>

        <ExpandLine icon={<KeyIcon className="h-4 w-4" />} title="Đổi mật khẩu" description="Cần mật khẩu hiện tại."
          open={tab === 'security'} onToggle={() => toggleLine('security')}>
          <Input type={showPassword ? 'text' : 'password'} value={oldPassword} aria-label="Mật khẩu hiện tại"
            onChange={e => { setOldPassword(e.target.value); clearMessages(); }} placeholder="Mật khẩu hiện tại" />
          <Input type={showPassword ? 'text' : 'password'} value={newPassword} aria-label="Mật khẩu mới"
            onChange={e => { setNewPassword(e.target.value); clearMessages(); }} placeholder="Mật khẩu mới (tối thiểu 4 ký tự)" />
          <Input type={showPassword ? 'text' : 'password'} value={confirmPassword} aria-label="Nhập lại mật khẩu mới"
            onChange={e => { setConfirmPassword(e.target.value); clearMessages(); }}
            onKeyDown={e => { if (e.key === 'Enter') void handleChangePassword(); }}
            placeholder="Nhập lại mật khẩu mới" />
          {showPasswordToggle}
          <Button onClick={handleChangePassword} disabled={loading}>{loading ? 'Đang xử lý...' : 'Đổi mật khẩu'}</Button>
          {messages}
        </ExpandLine>

        <ExpandLine icon={<HashIcon className="h-4 w-4" />} title="Mã khôi phục" description="Dùng khi quên mật khẩu. Nhập mật khẩu để xem."
          open={tab === 'recovery'} onToggle={() => toggleLine('recovery')}>
          {recoveryKey && recoveryView === 'show' ? (
            <>
              <RecoveryKeyBox value={recoveryKey} onCopy={() => handleCopyKey(recoveryKey)} />
              <p className="text-xs text-muted-foreground">Giữ mã này ở nơi an toàn, không chia sẻ cho người khác.</p>
            </>
          ) : (
            <>
              <Input type="password" value={password} aria-label="Mật khẩu"
                onChange={e => { setPassword(e.target.value); clearMessages(); }}
                onKeyDown={e => { if (e.key === 'Enter') void handleShowRecovery(); }}
                placeholder="Mật khẩu" />
              <Button variant="outline" onClick={handleShowRecovery} disabled={loading}>{loading ? 'Đang xử lý...' : 'Xem mã khôi phục'}</Button>
            </>
          )}
          {messages}
        </ExpandLine>

        <ExpandLine icon={<LockIcon className="h-4 w-4" />} title="Tắt khoá màn hình" description="Không cần mật khẩu khi mở app nữa."
          open={tab === 'disable'} onToggle={() => toggleLine('disable')} danger>
          <Input type="password" value={password} aria-label="Mật khẩu"
            onChange={e => { setPassword(e.target.value); clearMessages(); }}
            onKeyDown={e => { if (e.key === 'Enter') void handleDisable(); }}
            placeholder="Mật khẩu để tắt" />
          <Button variant="destructive" onClick={handleDisable} disabled={loading}>{loading ? 'Đang xử lý...' : 'Tắt khoá màn hình'}</Button>
          {messages}
        </ExpandLine>
      </SettingsSection>
      {/* Thông báo khi không mở dòng nào (vd vừa tắt khoá) */}
      {!tab && messages}
    </SettingsPage>
  );
}
