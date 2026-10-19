/**
 * TEMP harness: renders DesignSystemPage in a plain browser tab via the running Vite dev
 * server (http://localhost:27799/ds-preview.html?theme=dark|light). Delete with ds-preview.html.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { DesignSystemPage } from '@/components/ui/DesignSystemPage';

type Theme = 'dark' | 'light';
const initial: Theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = initial;
document.body.style.overflow = 'auto';
const w = window as unknown as { electronAPI?: unknown };
if (!w.electronAPI) {
  w.electronAPI = new Proxy({}, { get: () => () => Promise.resolve(undefined) });
}

function Harness() {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card/90 px-6 py-3 backdrop-blur">
        <div className="text-sm font-semibold">Deplao UI kit · preview</div>
        <button
          type="button"
          className="h-8 rounded-md border border-input bg-muted px-3 text-sm text-foreground hover:bg-accent"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          Theme: {theme}
        </button>
      </div>
      <div className="mx-auto max-w-5xl p-6">
        <DesignSystemPage />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
