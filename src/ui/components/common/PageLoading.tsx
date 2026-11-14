/**
 * PageLoading - Shared skeleton loading component for the whole app.
 *
 * When the REST API responds with a delay (employee mode through Boss), this component
 * shows a skeleton animation instead of a blank screen.
 *
 * Variants:
 *   - full (default): Spinner + text + skeleton bars, used for the whole page
 *   - inline: Small spinner + text, used for one section of the page
 *   - skeleton: Only skeleton bars, no spinner (used when many sections load together)
 *   - overlay: Overlay on top of the old content (used when refreshing data)
 *
 * Usage:
 *   {loading && <PageLoading />}
 *   {loading && <PageLoading variant="inline" text="Đang tải danh sách..." />}
 *   {loadingTable && <PageLoading variant="skeleton" skeletonVariant="table" />}
 */

// ── Config ────────────────────────────────────────────────────────────

import { tr } from '../../../shared/i18n';

const SKELETON_VARIANTS = {
  bars: [
    { width: '85%' },
    { width: '60%' },
    { width: '70%' },
    { width: '45%' },
    { width: '80%' },
  ],
  table: [
    { width: '100%', height: 'h-10' },
    { width: '100%', height: 'h-10' },
    { width: '100%', height: 'h-10' },
    { width: '100%', height: 'h-10' },
    { width: '100%', height: 'h-10' },
  ],
  cards: [
    { width: '100%', height: 'h-24' },
    { width: '100%', height: 'h-24' },
    { width: '100%', height: 'h-24' },
    { width: '100%', height: 'h-24' },
  ],
  chart: [
    { width: '100%', height: 'h-48' },
    { width: '100%', height: 'h-32' },
  ],
} as const;

// ── Types ─────────────────────────────────────────────────────────────

type PageVariant = 'full' | 'inline' | 'skeleton' | 'overlay';
type SkeletonVariant = keyof typeof SKELETON_VARIANTS;

export interface PageLoadingProps {
  text?: string;
  variant?: PageVariant;
  skeletonVariant?: SkeletonVariant;
  size?: 'sm' | 'md' | 'lg';
}

// ── Spinner ───────────────────────────────────────────────────────────

/** Shared spinner component for any place that needs a small loading indicator (button, icon) */
export function Spinner({ size = 5, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`animate-spin text-blue-400 ${className}`}
      style={{ width: `${size * 0.25}rem`, height: `${size * 0.25}rem` }}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Skeleton Blocks ───────────────────────────────────────────────────

function SkeletonBars({ variant }: { variant: SkeletonVariant }) {
  const bars = SKELETON_VARIANTS[variant] || SKELETON_VARIANTS.bars;
  return (
    <div className="w-full max-w-md space-y-3 mt-2">
      {bars.map((bar, i) => (
        <div
          key={i}
          className={`bg-muted/50 rounded animate-pulse ${bar.height || 'h-3'}`}
          style={{ width: bar.width }}
        />
      ))}
    </div>
  );
}

// ── PageLoading ───────────────────────────────────────────────────────

export default function PageLoading({
  text = tr('Đang tải...'),
  variant = 'full',
  skeletonVariant = 'bars',
  size = 'md',
}: PageLoadingProps) {
  // ── inline variant ──────────────────────────────────────────────────
  if (variant === 'inline') {
    const sizeClasses = { sm: 'gap-2 min-h-[60px]', md: 'gap-3 min-h-[100px]', lg: 'gap-4 min-h-[150px]' };
    const textSizes = { sm: 'text-xs', md: 'text-sm', lg: 'text-base' };
    const spinnerSizes = { sm: 4, md: 5, lg: 6 };
    return (
      <div className={`flex flex-col items-center justify-center w-full ${sizeClasses[size]} px-4`}>
        <Spinner size={spinnerSizes[size]} />
        <p className={`${textSizes[size]} text-muted-foreground`}>{text}</p>
      </div>
    );
  }

  // ── skeleton variant ────────────────────────────────────────────────
  if (variant === 'skeleton') {
    return (
      <div className="flex flex-col items-center justify-center w-full min-h-[100px] px-4 py-4">
        <SkeletonBars variant={skeletonVariant} />
      </div>
    );
  }

  // ── overlay variant ─────────────────────────────────────────────────
  if (variant === 'overlay') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/60 backdrop-blur-sm z-50 rounded-2xl">
        <div className="flex flex-col items-center gap-3 px-4">
          <Spinner size={6} />
          <p className="text-sm text-muted-foreground">{text}</p>
        </div>
      </div>
    );
  }

  // ── full variant (default) ──────────────────────────────────────────
  return (
    <div className="flex flex-col items-center justify-center h-full w-full min-h-[200px] gap-4 px-4">
      <Spinner size={6} />
      <p className="text-sm text-muted-foreground">{text}</p>
      <SkeletonBars variant={skeletonVariant} />
    </div>
  );
}
