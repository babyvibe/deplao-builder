/**
 * TelegramBotLoginStep.ts - Component đăng nhập Telegram Bot
 * Nhập botToken → validate getMe → tạo account + start polling
 */

import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { createDefaultLabels } from '@/lib/defaultLabels';
import { Spinner } from '@/components/common/PageLoading';
import { CheckIcon, AlertIcon } from '@/components/common/icons';

interface Props {
  onSuccess: () => void;
  onBack: () => void;
}

export default function TelegramBotLoginStep({ onSuccess, onBack }: Props) {
  const [botToken, setBotToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [botInfo, setBotInfo] = useState<any>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { showNotification } = useAppStore();
  const addAccount = useAccountStore(s => s.addAccount);

  const handleValidate = async () => {
    if (!botToken.trim()) {
      setError('Vui lòng nhập Bot Token');
      return;
    }
    setValidating(true);
    setError('');
    setBotInfo(null);

    try {
      const res = await ipc.telegram?.validateBot(botToken.trim());
      if (res?.success && res.bot) {
        setBotInfo(res.bot);
      } else {
        setError(res?.error || 'Token không hợp lệ');
      }
    } catch (err: any) {
      setError(err.message || 'Lỗi kết nối');
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    if (!botInfo) return;
    setSaving(true);

    try {
      const accountId = String(botInfo.id);
      
      // Add account to store
      addAccount({
        zalo_id: accountId,
        full_name: botInfo.first_name || 'Telegram Bot',
        avatar_url: '',
        phone: '',
        username: botInfo.username || '',
        imei: '',
        cookies: botToken.trim(),  // Store bot token in cookies field for reconnect
        user_agent: '',
        channel: 'telegram_bot',
      } as any);

      // Save to database via IPC (persist across restarts)
      try {
        await ipc.db?.saveAccount?.({
          zalo_id: accountId,
          full_name: botInfo.first_name || 'Telegram Bot',
          avatar_url: '',
          phone: '',
          username: botInfo.username || '',
          imei: '',
          cookies: botToken.trim(),  // Store bot token in cookies field for reconnect
          user_agent: '',
          is_active: 1,
          created_at: new Date().toISOString(),
          channel: 'telegram_bot',
        } as any);
      } catch (e) {
        console.warn('[TelegramBotLogin] Failed to save account to DB:', e);
      }

      // Start bot polling
      const startRes = await ipc.telegram?.startBot({
        accountId,
        botToken: botToken.trim(),
        botUsername: botInfo.username || '',
        botFirstName: botInfo.first_name || '',
      });

      // Update account status in store (startBot emits event:connected, but set it directly too)
      const { updateAccountStatus, updateListenerActive } = useAccountStore.getState();
      if (startRes?.success) {
        updateAccountStatus(accountId, true, true);
        updateListenerActive(accountId, true);
      }

      // Create default labels for new Telegram bot account
      await createDefaultLabels(accountId);

      showNotification(`Đã kết nối Bot @${botInfo.username || botInfo.first_name}!`, 'success');
      onSuccess();
    } catch (err: any) {
      showNotification('Lỗi: ' + (err.message || 'Không thể lưu'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-4">
      {/* Instructions */}
      <div className="bg-blue-900/20 border border-blue-700/30 rounded-xl p-4">
        <p className="text-blue-300 text-xs font-semibold mb-2">🤖 Tạo Bot Telegram</p>
        <ol className="text-blue-400 text-[11px] space-y-1.5 list-decimal list-inside leading-relaxed">
          <li>Mở Telegram, tìm <strong>@BotFather</strong></li>
          <li>Gửi lệnh <strong>/newbot</strong> và làm theo hướng dẫn</li>
          <li>Copy <strong>Bot Token</strong> (dạng: <code className="bg-card px-1 rounded">123456:ABC-DEF...</code>)</li>
          <li>Dán vào bên dưới và nhấn "Kiểm tra"</li>
        </ol>
      </div>

      {/* Token input */}
      <div>
        <label className="text-foreground/80 text-xs font-medium mb-1.5 block">Bot Token</label>
        <input
          type="text"
          value={botToken}
          onChange={e => { setBotToken(e.target.value); setError(''); setBotInfo(null); }}
          placeholder="7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"
          className="w-full bg-muted border border-input rounded-lg px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors"
          disabled={validating || saving}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-red-400 text-xs">
          <AlertIcon className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Bot info after validation */}
      {botInfo && (
        <div className="bg-green-900/20 border border-green-700/30 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-green-600/30 flex items-center justify-center">
              <CheckIcon className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <p className="text-sm font-semibold">
                @{botInfo.username || 'unknown'}
              </p>
              <p className="text-xs">{botInfo.first_name}</p>
            </div>
          </div>
          <p className="text-green-800 text-[14px] mt-3">
            ✅ Bot hợp lệ! Nhấn "Kết nối" để thêm vào app.
          </p>
        </div>
      )}

      {/* Warning */}
      <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-3">
        <p className="text-yellow-300 text-[11px] leading-relaxed">
          ⚠️ <strong>Lưu ý:</strong> Bot chỉ thấy tin nhắn từ lúc khách bấm "Start" trở đi, không có lịch sử cũ. 
          Nếu dùng trong nhóm, cần tắt Privacy Mode ở BotFather để bot thấy hết tin nhắn.
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={onBack}
          className="flex-1 px-4 py-2.5 bg-muted hover:bg-accent text-foreground/80 text-sm rounded-lg transition-colors"
        >
          Quay lại
        </button>
        {!botInfo ? (
          <button
            onClick={handleValidate}
            disabled={!botToken.trim() || validating}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {validating ? <><Spinner size={4} /> Đang kiểm tra...</> : 'Kiểm tra Token'}
          </button>
        ) : (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? <><Spinner size={4} /> Đang lưu...</> : 'Kết nối Bot'}
          </button>
        )}
      </div>
    </div>
  );
}
