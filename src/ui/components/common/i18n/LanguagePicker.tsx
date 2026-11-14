/**
 * UI language picker with flags (useUiLanguages: Vietnamese, English, Chinese…, ≥ 95% translated).
 *   variant "menu":  rows flag + name + ✓, for the TopBar "⋯" menu
 *   variant "chips": a row of flag buttons, for the start screen before any account exists
 * Renders nothing while only Vietnamese is available. Picking a language saves it and reloads the window.
 */
import React from 'react';
import LanguageFlag from './LanguageFlag';
import { useUiLanguages } from '@/hooks/i18n/useUiLanguages';
import { tr } from '../../../../shared/i18n';

export default function LanguagePicker({ variant, heading = false, onPicked, className = '' }: {
  variant: 'menu' | 'chips';
  /** menu: a "Ngôn ngữ" title above the rows and a divider below (a section of the "⋯" menu) */
  heading?: boolean;
  /** Called right after a click (e.g. close the menu); the window reloads once the language is saved */
  onPicked?: () => void;
  className?: string;
}) {
  const { current, options, change, changing } = useUiLanguages();
  if (options.length < 2) return null;

  const pick = (code: string) => {
    if (code !== current) void change(code);
    onPicked?.();
  };

  if (variant === 'chips') {
    return (
      <div role="radiogroup" aria-label={tr('Ngôn ngữ')} className={`flex flex-wrap items-center justify-center gap-2 ${className}`}>
        {options.map((o) => {
          const selected = o.code === current;
          return (
            <button
              key={o.code}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={changing}
              onClick={() => pick(o.code)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${selected
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-input bg-card text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <LanguageFlag code={o.code} />
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-label={tr('Ngôn ngữ')} className={`${heading ? 'py-1.5 border-b border-border' : ''} ${className}`}>
      {heading && <p className="px-4 pt-1 pb-1 text-xs text-muted-foreground font-medium">{tr('Ngôn ngữ')}</p>}
      {options.map((o) => {
        const selected = o.code === current;
        return (
          <button
            key={o.code}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={changing}
            onClick={() => pick(o.code)}
            className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-xs transition-colors disabled:opacity-60 ${selected ? 'bg-muted text-foreground font-medium' : 'text-foreground/80 hover:bg-muted hover:text-foreground'}`}
          >
            <LanguageFlag code={o.code} />
            <span className="flex-1 min-w-0 truncate">{o.label}</span>
            {selected && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary shrink-0" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
