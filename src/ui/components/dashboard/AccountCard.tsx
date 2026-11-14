import React, { useState, useRef, useEffect } from 'react';
import { AccountInfo } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import ipc, { buildZaloAuth } from '@/lib/ipc'
import { handleAvatarError } from '@/lib/contacts/avatarRetry'
import DataAccessor from '@/lib/data/DataAccessor';;
import { formatPhone } from '@/lib/contacts/phoneUtils';
import PhoneDisplay from '../common/inputs/PhoneDisplay';
import CopyableText from '../common/inputs/CopyableText';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/lib/app/apiError';
import ChannelBadge from '../common/avatars/ChannelBadge';
import { CHANNEL, isZalo, isFacebook, isTelegram, isTelegramUser, isTelegramBot } from '@/lib/channels/channelHelper';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { PhoneIcon } from '@/components/common/icons';
import { Spinner } from '@/components/common/PageLoading';
import type { Channel } from '@/../configs/channels/channelConfig';
import { channelSupports, resolveAccountChannel, getChannelLabel } from '@/../configs/channels/channelConfig';
import * as channelIpc from '@/lib/channels/channelIpc';
import { tr } from '../../../shared/i18n';

interface AccountCardProps {
  account: AccountInfo;
  onReconnect?: (acc: AccountInfo) => void;
  employeeChatOnly?: boolean;
}

export default function AccountCard({ account: acc, onReconnect, employeeChatOnly = false }: AccountCardProps) {
  const { setActiveAccount, updateAccountStatus, updateListenerActive } = useAccountStore();
  const { setView, showNotification, setAddAccountModalOpen } = useAppStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [updatingInfo, setUpdatingInfo] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarRetryDone = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const accountChannel = resolveAccountChannel(acc);
  const isFacebookAcc = isFacebook(accountChannel);
  const isZaloAcc = isZalo(accountChannel);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // listenerActive: undefined = unknown, true = OK, false = dead
  const listenerDead = acc.listenerActive === false;

  const handleReconnect = async () => {
    if (onReconnect && isZaloAcc) { onReconnect(acc); return; }
    showNotification(tr('Đang kết nối {{v1}}...', { v1: acc.full_name || acc.zalo_id }), 'info');
    try {
      if (!isZaloAcc) {
        // Pass the right auth for each Telegram type
        // Telegram User: stringSession (stored in the cookies column)
        // Telegram Bot: botToken (stored in the cookies column)
        const auth = isTelegramUser(accountChannel)
          ? { stringSession: acc.cookies }
          : isTelegramBot(accountChannel)
            ? { botToken: acc.cookies, botName: acc.full_name }
            : undefined;
        const res = await channelIpc.connectAccount(accountChannel, { accountId: acc.zalo_id, auth });
        if (res?.success) {
          updateAccountStatus(acc.zalo_id, true, true);
          updateListenerActive(acc.zalo_id, true);
          showNotification(tr('Kết nối {{v1}} thành công!', { v1: getChannelLabel(accountChannel) }), 'success');
        } else {
          updateListenerActive(acc.zalo_id, false);
          showNotification(res?.error || tr('Kết nối {{v1}} thất bại', { v1: getChannelLabel(accountChannel) }), 'error');
        }
        return;
      }
      const auth = buildZaloAuth(acc);
      const res = await ipc.login?.connectAccount(auth);
      if (res?.success) {
        updateAccountStatus(acc.zalo_id, true, true);
        updateListenerActive(acc.zalo_id, true);
        showNotification(tr('Kết nối thành công!'), 'success');
      } else {
        updateListenerActive(acc.zalo_id, false);
        showNotification(res?.error || tr('Kết nối thất bại'), 'error');
      }
    } catch (err: any) {
      updateListenerActive(acc.zalo_id, false);
      showNotification(err.message, 'error');
    }
  };

  const handleDisconnect = async () => {
    try {
      if (!isZaloAcc) {
        await channelIpc.disconnectAccount(accountChannel, { accountId: acc.zalo_id });
      } else {
        await ipc.login?.disconnectAccount(acc.zalo_id);
      }
      updateAccountStatus(acc.zalo_id, false, false);
      showNotification(tr('Đã ngắt kết nối'), 'info');
    } catch (err: any) {
      showNotification(err.message, 'error');
    }
  };

  const handleDeleteAccount = async () => {
    setMenuOpen(false);
    const ok = await showConfirm({
      title: tr('Xóa tài khoản này?'),
      // All channels (including Facebook) keep their data; delete the data too only in Settings → Accounts
      message: tr('Tài khoản "{{v1}}" sẽ bị xóa khỏi ứng dụng. Tin nhắn, hội thoại và dữ liệu CRM vẫn được giữ — đăng nhập lại đúng tài khoản này để dùng tiếp. Muốn xóa cả dữ liệu, dùng Cài đặt → Tài khoản → "Xoá tất cả dữ liệu".', { v1: acc.full_name || acc.zalo_id }),
      confirmText: tr('Xóa'),
      variant: 'danger',
    });
    if (!ok) return;
    if (isFacebookAcc) {
      const res = await ipc.fb?.removeAccount({ accountId: acc.zalo_id });
      if (res?.success) {
        useAccountStore.getState().removeAccount(acc.zalo_id);
        showNotification(tr('Đã xóa tài khoản Facebook'), 'success');
      } else {
        showNotification(res?.error || tr('Xóa tài khoản thất bại'), 'error');
      }
      return;
    }
    const res = await ipc.login?.removeAccount(acc.zalo_id);
    if (res?.success) {
      useAccountStore.getState().removeAccount(acc.zalo_id);
      showNotification(tr('Đã xóa tài khoản'), 'success');
    } else {
      showNotification(extractApiError(res, tr('Xóa tài khoản thất bại')), 'error');
    }
  };

  const handleUpdateInfo = async () => {
    setMenuOpen(false);
    setUpdatingInfo(true);
    try {
      const channel = accountChannel;

      if (isTelegram(channel)) {
        // Telegram: reset the avatar cache and fetch the avatar again
        try {
          const { resetAvatarCache } = await import('../../../utils/telegram/avatarFetchCache');
          resetAvatarCache(acc.zalo_id, acc.zalo_id);
        } catch {}

        if (isTelegramUser(channel)) {
          // Telegram User: fetch avatar qua IPC
          try {
            const res = await ipc.telegramUser?.fetchSelfAvatar?.(acc.zalo_id);
            if (res?.success && res.avatarUrl) {
              useAccountStore.getState().updateAccount(acc.zalo_id, { avatar_url: res.avatarUrl });
              showNotification(tr('Đã cập nhật avatar Telegram!'), 'success');
            } else {
              showNotification(res?.error || tr('Không thể tải avatar. Đảm bảo Telegram đang kết nối.'), 'info');
            }
          } catch {
            showNotification(tr('Đảm bảo Telegram đang kết nối để cập nhật avatar.'), 'info');
          }
        } else {
          // Telegram Bot: the bot has no avatar of its own
          showNotification(tr('Bot không có avatar. Thông tin được cập nhật tự động khi có tin nhắn mới.'), 'info');
        }
      } else {
        // Zalo: existing logic
        const auth = buildZaloAuth(acc);
        const res = await ipc.zalo?.getContext({ auth });
        if (res?.success && res.response) {
          const ctx = res.response;
          const loginInfo = ctx.loginInfo || {};
          const uid: string = ctx.uid || acc.zalo_id;

          const displayName: string = acc.full_name || acc.zalo_id;
          const avatarUrl: string = acc.avatar_url || '';

          const rawPhone: string =
            loginInfo.phone_number ||
            loginInfo.phoneNumber ||
            loginInfo.phone ||
            loginInfo.msisdn ||
            '';
          const phone: string = formatPhone(rawPhone) || acc.phone || '';

          if (phone && phone !== acc.phone) {
            await DataAccessor.updateContactProfile({ zaloId: uid, contactId: uid, displayName, avatarUrl, phone });
            await DataAccessor.updateAccountPhone({ zaloId: uid, phone });
            useAccountStore.getState().updateAccount(uid, { phone });
            showNotification(tr('Đã cập nhật số điện thoại: {{phone}}', { phone }), 'success');
          } else {
            showNotification(tr('Thông tin đã cập nhật (SĐT không đổi)'), 'info');
          }
        } else {
          showNotification(tr('Không thể tải thông tin: {{v1}}', { v1: (res?.error || tr('Lỗi không xác định')) }), 'error');
        }
      }
    } catch (err: any) {
      showNotification(tr('Lỗi cập nhật: {{message}}', { message: err.message }), 'error');
    } finally {
      setUpdatingInfo(false);
    }
  };

  const handleUpdateFBInfo = async () => {
    setMenuOpen(false);
    setUpdatingInfo(true);
    try {
      const res = await ipc.fb?.refreshProfile({ accountId: acc.zalo_id });
      if (res?.success) {
        const updates: Partial<AccountInfo> = {};
        if (res.name) updates.full_name = res.name;
        if (res.avatarUrl) updates.avatar_url = res.avatarUrl;
        if (res.facebookId) updates.facebook_id = res.facebookId;
        if (Object.keys(updates).length > 0) {
          useAccountStore.getState().updateAccount(acc.zalo_id, updates);
        }
        showNotification(tr('Đã cập nhật: {{v1}}', { v1: res.name || acc.full_name }), 'success');
      } else {
        showNotification(res?.error || tr('Cập nhật thông tin FB thất bại'), 'error');
      }
    } catch (err: any) {
      showNotification(tr('Lỗi cập nhật: {{message}}', { message: err.message }), 'error');
    } finally {
      setUpdatingInfo(false);
    }
  };

  // Badge status
  const statusBadge = (() => {
    if (listenerDead) {
      return { label: tr('⚠ Listener chết'), cls: 'bg-red-900/40 text-red-400 border border-red-700/50', dot: 'bg-red-400 animate-pulse' };
    }
    if (acc.isOnline) {
      return { label: tr('Online'), cls: 'bg-green-900/40 text-green-400 border border-green-700/50', dot: 'bg-green-400' };
    }
    if (acc.isConnected) {
      return { label: tr('Đang kết nối'), cls: 'bg-yellow-900/40 text-yellow-400 border border-yellow-700/50', dot: 'bg-yellow-400 animate-pulse' };
    }
    return { label: tr('Offline'), cls: 'bg-muted/50 text-muted-foreground border border-input/50', dot: 'bg-accent' };
  })();

  return (
    <>
    <div className={`bg-card rounded-xl p-4 border transition-colors ${listenerDead ? 'border-red-700/60' : 'border-border hover:border-input'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-shrink-0">
          {acc.avatar_url && !avatarFailed ? (
            <img src={toLocalMediaUrl(acc.avatar_url)} alt="" className="w-12 h-12 rounded-full object-cover"
              onError={() => {
                setAvatarFailed(true);
                // Retry: call the refresh avatar API
                if (!avatarRetryDone.current) {
                  avatarRetryDone.current = true;
                  handleAvatarError({ ownerId: acc.zalo_id, contactId: acc.zalo_id, channel: acc.channel || CHANNEL.ZALO })
                    .then(newUrl => {
                      if (newUrl) {
                        useAccountStore.getState().updateAccount(acc.zalo_id, { avatar_url: newUrl });
                        setAvatarFailed(false);
                      }
                    }).catch(() => {});
                }
              }} />
          ) : (
            <div className={`w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-lg ${isFacebookAcc ? 'bg-blue-800' : 'bg-blue-600'}`}>
              {isFacebookAcc ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
              ) : (acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
            </div>
          )}
          {/* Status dot */}
          <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-border ${statusBadge.dot}`} />
          {/* Channel badge */}
          <div className="absolute -top-0.5 -left-0.5 z-10">
            <ChannelBadge channel={accountChannel} size="md" />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
            {acc.full_name || tr('{{v1}} Account', { v1: getChannelLabel(accountChannel) })}
            {listenerDead && (
              <span className="relative group flex-shrink-0">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-card border border-input rounded-lg text-[10px] text-red-300 whitespace-nowrap z-50 hidden group-hover:block shadow-lg">
                  {tr('Listener bị ngắt - Thử kết nối lại hoặc quét QR mới')}
                </span>
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            <CopyableText value={isFacebookAcc ? `${acc.facebook_id || acc.zalo_id}` : acc.zalo_id} title={tr('Click để copy UID')} />
          </p>
          {acc.phone ? (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              <PhoneIcon className="w-3 h-3 inline" /> <PhoneDisplay phone={acc.phone} className="text-xs text-muted-foreground" />
            </p>
          ) : acc.username ? (
            <p className="text-xs text-muted-foreground truncate mt-0.5">@{acc.username}</p>
          ) : null}
        </div>

        {/* 3-dot menu */}
        {!employeeChatOnly && (
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={tr('Tùy chọn')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
            </svg>
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-8 w-52 bg-card border border-input rounded-xl shadow-xl z-50 py-1 overflow-hidden">
              {isFacebookAcc ? (
                <button
                  onClick={handleUpdateFBInfo}
                  disabled={updatingInfo}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                >
                  {updatingInfo ? (
                    <Spinner size={4} />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                    </svg>
                  )}
                  {updatingInfo ? tr('Đang cập nhật...') : tr('Cập nhật thông tin')}
                </button>
              ) : (
              <button
                onClick={handleUpdateInfo}
                disabled={updatingInfo}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors disabled:opacity-50"
              >
                {updatingInfo ? (
                  <Spinner size={4} />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                )}
                {updatingInfo ? tr('Đang cập nhật...') : tr('Cập nhật thông tin')}
              </button>
              )}

              <div className="border-t border-border my-1" />

              <button
                onClick={() => { setMenuOpen(false); setActiveAccount(acc.zalo_id); setView('chat'); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                </svg>
                {tr('Mở Chat')}
              </button>

              <button
                onClick={() => {
                  setMenuOpen(false);
                  const uid = isFacebookAcc ? (acc.facebook_id || acc.zalo_id) : acc.zalo_id;
                  navigator.clipboard.writeText(uid).then(() => {
                    showNotification(tr('Đã sao chép UID: {{uid}}', { uid }), 'success');
                  }).catch(() => {
                    showNotification(tr('Không thể sao chép UID'), 'error');
                  });
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                {tr('Copy UID')}
              </button>

              <div className="border-t border-border my-1" />

              <button
                onClick={handleDeleteAccount}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                  <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                </svg>
                {tr('Xóa tài khoản')}
              </button>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {/* Row 1: Chat + Connect/Disconnect - hide Chat when the listener is dead */}
        <div className="flex gap-2">
          {!listenerDead && (
            <button
              onClick={() => { setActiveAccount(acc.zalo_id); setView('chat'); }}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs py-1.5 rounded-lg transition-colors font-medium"
            >
              {tr('Chat')}
            </button>
          )}

          {/* Show the connect/disconnect button only when the listener is NOT dead */}
          {!employeeChatOnly && !listenerDead && (acc.isConnected ? (
            <button
              title={tr('Ngắt kết nối sẽ dừng nghe tin nhắn và đánh dấu tài khoản offline.')}
              onClick={handleDisconnect}
              className="flex-1 bg-muted hover:bg-accent text-foreground/80 text-xs py-1.5 rounded-lg transition-colors font-medium"
            >
              {tr('Ngắt kết nối')}
            </button>
          ) : (
            <button
              title={tr('Kết nối lại để tiếp tục nhận tin nhắn.')}
              onClick={handleReconnect}
              className="flex-1 bg-orange-700 text-white-important hover:bg-accent text-foreground/80 text-xs py-1.5 rounded-lg transition-colors font-medium"
            >
              {tr('Kết nối lại')}
            </button>
          ))}
        </div>

        {/* Row 2: shown only when the listener is dead - 2 buttons: Reconnect + Scan new QR (Zalo) / Log in again (FB, Telegram) */}
        {!employeeChatOnly && listenerDead && (
          <div className="flex gap-2">
            <button
              onClick={handleReconnect}
              className="flex-1 bg-orange-700 hover:bg-orange-600 text-white-important text-xs py-1.5 rounded-lg transition-colors font-medium flex items-center justify-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {tr('Reconnect')}
            </button>
            <button
              onClick={() => {
                if (isZaloAcc) {
                  setAddAccountModalOpen(true);
                } else {
                  // Facebook / Telegram session expired: open the login popup from scratch (like adding a new account).
                  // Facebook preselects the proxy in use; logging in to the same old account keeps the conversations and messages.
                  setAddAccountModalOpen(true, accountChannel, isFacebookAcc ? acc.proxy_id ?? null : null);
                }
              }}
              className="flex-1 bg-blue-800 hover:bg-blue-700 text-white text-xs py-1.5 rounded-lg transition-colors font-medium flex items-center justify-center gap-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                {isZaloAcc ? (
                  <><rect x="3" y="3" width="5" height="5" /><rect x="16" y="3" width="5" height="5" /><rect x="3" y="16" width="5" height="5" /><path d="M21 16h-3v3M21 21h-3v-3M16 21h-3v-3M13 16h3" /></>
                ) : (
                  <><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></>
                )}
              </svg>
              {isZaloAcc ? tr('Quét QR mới') : tr('Đăng nhập lại')}
            </button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
