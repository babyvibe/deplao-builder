import React, { useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { useWorkspaceStore } from '@/store/workspaceStore';

interface Props {
  onClose: () => void;
}

export default function EmployeeLoginModal({ onClose }: Props) {
  const { showNotification } = useAppStore();
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('9900');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'idle' | 'logging-in' | 'connecting' | 'switching'>('idle');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    if (!ip.trim() || !username.trim() || !password.trim()) {
      setError('Vui lòng nhập đầy đủ thông tin');
      return;
    }
    setLoading(true);
    setError('');
    const bossUrl = `http://${ip.trim()}:${port.trim() || '9900'}`;

    try {
      // Step 1: Login to boss
      setStep('logging-in');
      const loginRes = await ipc.workspace?.loginRemote(bossUrl, username.trim(), password);
      if (!loginRes?.success) {
        setError(loginRes?.error || 'Đăng nhập thất bại. Kiểm tra lại thông tin.');
        setLoading(false);
        setStep('idle');
        return;
      }

      // Step 2: Create workspace
      setStep('connecting');
      const wsName = name.trim() || `NV - ${loginRes.employee?.display_name || username.trim()}`;
      const res = await ipc.workspace?.create({
        name: wsName,
        type: 'remote',
        icon: '👤',
        bossUrl,
        token: loginRes.token,
        employeeId: loginRes.employee?.employee_id,
        employeeName: loginRes.employee?.display_name || username.trim(),
        employeeUsername: username.trim(),
        autoConnect: true,
      });

      if (!res?.success) {
        setError(res?.error || 'Tạo workspace thất bại');
        setLoading(false);
        setStep('idle');
        return;
      }

      // Step 3: Connect to Boss
      if (res.workspace?.id && loginRes.token) {
        await ipc.workspace?.connectRemote(res.workspace.id, bossUrl, loginRes.token);
      }

      // Step 4: Switch to the new workspace
      setStep('switching');
      if (res.workspace?.id) {
        await ipc.workspace?.switch(res.workspace.id);
      }

      // Reload workspace list
      const listRes = await ipc.workspace?.list();
      if (listRes?.success) {
        useWorkspaceStore.getState().setWorkspaces(listRes.workspaces);
      }

      showNotification(`Đã đăng nhập workspace "${wsName}"`, 'success');
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Lỗi không xác định');
    }
    setLoading(false);
    setStep('idle');
  };

  const stepLabel = step === 'logging-in' ? 'Đang đăng nhập...'
    : step === 'connecting' ? 'Đang kết nối...'
    : step === 'switching' ? 'Đang chuyển workspace...'
    : 'Đăng nhập';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 rounded-2xl w-full max-w-md shadow-2xl border border-gray-700" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-white font-semibold">👤 Đăng nhập nhân viên</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-gray-400 text-sm">
            Nhập thông tin kết nối tới máy Boss để đăng nhập dưới vai trò nhân viên.
          </p>

          <div>
            <label className="text-xs text-gray-400 font-medium mb-1 block">Tên workspace (tùy chọn)</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="VD: NV Công ty ABC"
              className="w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-gray-400 font-medium mb-1 block">IP BOSS</label>
              <input
                value={ip}
                onChange={e => setIp(e.target.value)}
                placeholder="192.168.1.100"
                className="w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="w-20">
              <label className="text-xs text-gray-400 font-medium mb-1 block">Port</label>
              <input
                value={port}
                onChange={e => setPort(e.target.value)}
                placeholder="9900"
                className="w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-400 font-medium mb-1 block">Tên đăng nhập</label>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="username"
              className="w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="text-xs text-gray-400 font-medium mb-1 block">Mật khẩu</label>
            <input
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }}
              placeholder="••••••••"
              type="password"
              className="w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-700 rounded-lg p-2.5 text-red-400 text-xs">
              {error}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading || !ip.trim() || !username.trim() || !password.trim()}
            className="w-full text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 px-4 py-2.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading && (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" />
              </svg>
            )}
            {stepLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

