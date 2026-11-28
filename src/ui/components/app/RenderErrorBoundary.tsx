import React from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';
import ipc from '@/lib/ipc';
import {
  formatRenderErrorLog, isChunkLoadError, renderErrorDetails, renderErrorSummary, resetKeysChanged,
} from '@/lib/app/renderError';
import { tr } from '../../../shared/i18n';
import Logger from '../../../utils/Logger';

/**
 * Where the fallback is drawn:
 * - app: the whole window (wraps <App /> in main.tsx). Draws its own title bar: the window is frameless and TopBar is gone.
 * - section: a screen area (message list, conversation list, a page); fills its slot.
 * - panel: a right-hand panel (320 px), with a close button when onClose is given.
 * - inline: a one-line bar for a strip of the screen (chat header, composer).
 */
export type RenderErrorVariant = 'app' | 'section' | 'panel' | 'inline';

export interface RenderErrorBoundaryProps {
  /** Short id written in the log line: 'app', 'chat-window', 'page:crm', 'conversation-info'… */
  name: string;
  variant?: RenderErrorVariant;
  /** The boundary clears itself when one of these changes (another conversation, another page…). */
  resetKeys?: readonly unknown[];
  /** Panel only: closes the panel from the fallback. */
  onClose?: () => void;
  children?: React.ReactNode;
}

interface RenderErrorBoundaryState {
  hasError: boolean;
  /** Whatever was thrown (may be a non-Error value, hence the separate flag). */
  error: unknown;
}

/**
 * Catches errors thrown while rendering its children, so one broken screen does not unmount the whole app (React removes
 * the entire tree when nothing catches, leaving a blank window). Logs one line through Logger (forwarded to Nhật ký) and
 * shows a fallback with Thử lại (render again) and Tải lại (reload the page).
 */
export class RenderErrorBoundary extends React.Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): RenderErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    Logger.error(formatRenderErrorLog(this.props.name, error, info?.componentStack));
  }

  componentDidUpdate(prevProps: RenderErrorBoundaryProps, prevState: RenderErrorBoundaryState): void {
    // Only an error that was already on screen is cleared: when the key change itself caused the error, the first
    // update after it must not reset (that would render the failing tree again in a loop).
    if (this.state.hasError && prevState.hasError && resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <RenderErrorFallback
        variant={this.props.variant ?? 'section'}
        error={this.state.error}
        onRetry={this.reset}
        onClose={this.props.onClose}
      />
    );
  }
}

export interface RenderErrorFallbackProps {
  variant: RenderErrorVariant;
  error: unknown;
  onRetry: () => void;
  onClose?: () => void;
}

/** Fallback of RenderErrorBoundary. Uses only UI primitives and tr(): it must not depend on stores that may be broken. */
export function RenderErrorFallback({ variant, error, onRetry, onClose }: RenderErrorFallbackProps) {
  // React.lazy keeps a failed import: rendering again throws the same error, only a reload helps
  const reloadOnly = isChunkLoadError(error);
  const reload = () => window.location.reload();
  const size = variant === 'panel' || variant === 'inline' ? 'sm' : 'md';
  const retryButton = reloadOnly ? null : (
    <Button size={size} variant={variant === 'app' ? 'outline' : 'primary'} onClick={onRetry}>{tr('Thử lại')}</Button>
  );
  const reloadButton = (
    <Button size={size} variant={variant === 'app' || reloadOnly ? 'primary' : 'outline'} onClick={reload}>{tr('Tải lại')}</Button>
  );
  const title = tr('Không hiển thị được phần này');

  if (variant === 'inline') {
    return (
      <div role="alert" title={renderErrorSummary(error)}
        className="flex flex-shrink-0 items-center gap-2 border-y border-border bg-card px-3 py-2 text-sm text-foreground">
        <WarningIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {retryButton}
        {reloadButton}
      </div>
    );
  }

  const details = <RenderErrorDetails text={renderErrorDetails(error)} />;
  if (variant === 'app') {
    return (
      <div role="alert" className="flex h-screen flex-col bg-background text-foreground">
        <FallbackTitleBar />
        <div className="flex flex-1 items-center justify-center overflow-auto p-6">
          <div className="w-full max-w-md">
            <EmptyState
              className="pb-0"
              icon={<WarningIcon />}
              title={tr('Giao diện gặp lỗi')}
              description={tr('Tài khoản vẫn kết nối, tin nhắn vẫn được lưu. Bấm Tải lại để dùng tiếp.')}
              action={<>{reloadButton}{retryButton}</>}
            />
            {details}
          </div>
        </div>
      </div>
    );
  }

  const hint = reloadOnly ? tr('Bấm Tải lại để dùng tiếp.') : tr('Bấm Thử lại hoặc mở mục khác.');
  if (variant === 'panel') {
    return (
      <div role="alert" className="flex h-full w-80 max-w-full flex-col border-l border-border bg-card text-foreground shadow-2xl">
        {onClose && (
          <div className="flex justify-end p-2">
            <Button variant="ghost" size="icon" onClick={onClose} title={tr('Đóng')} aria-label={tr('Đóng')}>
              <CloseIcon />
            </Button>
          </div>
        )}
        <div className={cn('flex flex-1 flex-col justify-center overflow-auto px-4 pb-4', !onClose && 'pt-4')}>
          <EmptyState compact className="pb-0" icon={<WarningIcon />} title={title} description={hint}
            action={<>{retryButton}{reloadButton}</>} />
          {details}
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="flex h-full w-full min-w-0 flex-1 items-center justify-center overflow-auto bg-background p-6 text-foreground">
      <div className="w-full max-w-md">
        <EmptyState className="pb-0" icon={<WarningIcon />} title={title} description={hint}
          action={<>{retryButton}{reloadButton}</>} />
        {details}
      </div>
    </div>
  );
}

/** Collapsed error text, selectable so it can be copied into a bug report. Sits right under the buttons. */
function RenderErrorDetails({ text }: { text: string }) {
  return (
    <details className="mt-4 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none text-center">{tr('Chi tiết lỗi')}</summary>
      <pre className="mt-2 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-left font-mono text-[11px]">
        {text}
      </pre>
    </details>
  );
}

/** Drag area + window buttons, like TopBar, without its stores (the fallback must render even when they are broken). */
function FallbackTitleBar() {
  const isMac = typeof window !== 'undefined' && (window as any).electronAPI?.platform === 'darwin';
  const buttonClass = 'flex h-9 w-9 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';
  return (
    <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-border bg-card"
      style={{ WebkitAppRegion: 'drag' } as any}>
      <span className="text-sm font-bold text-blue-400" style={{ paddingLeft: isMac ? 72 : 12 }}>Deplao</span>
      {!isMac && (
        <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button type="button" className={buttonClass} title={tr('Thu nhỏ')} onClick={() => ipc.window?.minimize()}>
            <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor" aria-hidden="true"><rect width="10" height="1" /></svg>
          </button>
          <button type="button" className={buttonClass} title={tr('Phóng to')} onClick={() => ipc.window?.maximize()}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
              <rect x="0" y="0" width="10" height="10" />
            </svg>
          </button>
          <button type="button" className={cn(buttonClass, 'hover:bg-red-600 hover:text-white')} title={tr('Đóng')}
            onClick={() => ipc.window?.close()}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}

function WarningIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <line x1="0" y1="0" x2="10" y2="10" />
      <line x1="10" y1="0" x2="0" y2="10" />
    </svg>
  );
}

export default RenderErrorBoundary;
