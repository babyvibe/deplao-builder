import React, { useEffect, useRef, useState } from 'react';

interface ErpOverlayProps {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
  backdropClassName?: string;
  closeOnEscape?: boolean;
}

export function ErpOverlay({
  children,
  onClose,
  className = 'z-[9999]',
  backdropClassName = 'bg-black/60',
  closeOnEscape = true,
}: ErpOverlayProps) {
  useEffect(() => {
    if (!closeOnEscape) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeOnEscape, onClose]);

  return (
    <div
      className={`fixed inset-0 ${backdropClassName} flex items-center justify-center p-4 ${className}`}
      onClick={onClose}
    >
      {children}
    </div>
  );
}

export function ErpModalCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl ${className}`}
      onClick={event => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

interface ErpModalProps {
  title?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  panelClassName?: string;
  bodyClassName?: string;
  overlayClassName?: string;
  backdropClassName?: string;
  showCloseButton?: boolean;
}

export function ErpModal({
  title,
  onClose,
  children,
  footer,
  panelClassName = 'w-full max-w-md p-5',
  bodyClassName = '',
  overlayClassName,
  backdropClassName,
  showCloseButton = false,
}: ErpModalProps) {
  return (
    <ErpOverlay onClose={onClose} className={overlayClassName} backdropClassName={backdropClassName}>
      <ErpModalCard className={panelClassName}>
        {(title || showCloseButton) && (
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="min-w-0">{title}</div>
            {showCloseButton && (
              <button onClick={onClose} className="text-gray-400 hover:text-white w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-700/70">
                ✕
              </button>
            )}
          </div>
        )}
        <div className={bodyClassName}>{children}</div>
        {footer && <div className="mt-4">{footer}</div>}
      </ErpModalCard>
    </ErpOverlay>
  );
}

// ─── Confirm Dialog ────────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
}

export function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = 'Xác nhận', danger = true }: ConfirmDialogProps) {
  return (
    <ErpModal
      onClose={onCancel}
      panelClassName="w-80 p-5"
      bodyClassName="space-y-4"
    >
      <p className="text-sm text-gray-200 leading-relaxed">{message}</p>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel}
          className="px-4 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors">
          Huỷ
        </button>
        <button onClick={onConfirm}
          className={`px-4 py-1.5 text-sm text-white rounded-lg transition-colors ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}`}>
          {confirmLabel}
        </button>
      </div>
    </ErpModal>
  );
}

// ─── Prompt Dialog ─────────────────────────────────────────────────────────────

interface PromptDialogProps {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({ title, placeholder = '', defaultValue = '', onConfirm, onCancel }: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, []);

  const handleSubmit = () => { if (value.trim()) onConfirm(value.trim()); };

  return (
    <ErpModal
      title={<p className="text-sm font-semibold text-white">{title}</p>}
      onClose={onCancel}
      panelClassName="w-80 p-5"
      bodyClassName="space-y-3"
    >
        <input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onCancel(); }}
          placeholder={placeholder}
          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors">
            Huỷ
          </button>
          <button onClick={handleSubmit} disabled={!value.trim()}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors">
            OK
          </button>
        </div>
    </ErpModal>
  );
}

