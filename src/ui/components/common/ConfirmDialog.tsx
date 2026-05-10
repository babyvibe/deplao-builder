/**
 * ConfirmDialog — Beautiful confirm dialog, replacement for window.confirm()
 *
 * Usage (imperative, anywhere):
 *   import { showConfirm } from '../common/ConfirmDialog';
 *   const ok = await showConfirm({ title: 'Xóa?', message: 'Không thể hoàn tác.' });
 *
 * Usage (as component):
 *   <ConfirmDialog open={open} title="..." message="..." onConfirm={...} onCancel={...} />
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

export type ConfirmVariant = 'danger' | 'warning' | 'info';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = 'Xác nhận',
  cancelText = 'Hủy',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmOptions & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const iconMap: Record<ConfirmVariant, React.ReactNode> = {
    danger: (
      <div className="w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center flex-shrink-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
        </svg>
      </div>
    ),
    warning: (
      <div className="w-12 h-12 rounded-full bg-yellow-500/15 flex items-center justify-center flex-shrink-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-yellow-400">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
    ),
    info: (
      <div className="w-12 h-12 rounded-full bg-blue-500/15 flex items-center justify-center flex-shrink-0">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
    ),
  };

  const confirmBtnClass: Record<ConfirmVariant, string> = {
    danger:  'bg-red-600 hover:bg-red-700 text-white',
    warning: 'bg-yellow-600 hover:bg-yellow-700 text-white',
    info:    'bg-blue-600 hover:bg-blue-700 text-white',
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[10001]"
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={dialogRef}
        className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        style={{ animation: 'dialogIn 0.15s ease-out' }}
      >
        <div className="px-6 pt-6 pb-5 flex items-start gap-4">
          {iconMap[variant]}
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="text-white font-semibold text-base leading-snug mb-1">{title}</h3>
            {message && (
              <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-line">{message}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-700/60">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={`px-5 py-2 rounded-xl text-sm font-semibold transition-colors ${confirmBtnClass[variant]}`}
          >
            {confirmText}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes dialogIn {
          from { opacity: 0; transform: scale(0.95) translateY(4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ─── Imperative API ───────────────────────────────────────────────────────────

/**
 * showConfirm — Imperative confirm dialog (returns Promise<boolean>)
 * Replaces window.confirm() globally.
 *
 * @example
 * const ok = await showConfirm({ title: 'Xóa tài khoản?', message: 'Không thể hoàn tác.', variant: 'danger' });
 * if (!ok) return;
 */
export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const cleanup = (result: boolean) => {
      root.unmount();
      container.remove();
      resolve(result);
    };

    root.render(
      <ConfirmDialog
        {...options}
        open
        onConfirm={() => cleanup(true)}
        onCancel={() => cleanup(false)}
      />
    );
  });
}

// ─── useConfirm hook ──────────────────────────────────────────────────────────

/**
 * useConfirm — React hook for inline confirm dialog (renders in component tree)
 *
 * @example
 * const { confirm, ConfirmModal } = useConfirm();
 * const ok = await confirm({ title: 'Rời nhóm?', variant: 'warning' });
 * return <div>...{ConfirmModal}</div>;
 */
export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      setState({ ...options, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    state?.resolve(true);
    setState(null);
  }, [state]);

  const handleCancel = useCallback(() => {
    state?.resolve(false);
    setState(null);
  }, [state]);

  const ConfirmModal = state ? (
    <ConfirmDialog
      {...state}
      open
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  ) : null;

  return { confirm, ConfirmModal };
}

