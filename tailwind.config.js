/** @type {import('tailwindcss').Config} */
// Semantic colour tokens: values are RGB channels defined in src/ui/index.css
// (dark on :root / html[data-theme="dark"], light on html[data-theme="light"]).
// The `<alpha-value>` placeholder keeps opacity modifiers working (bg-card/50).
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: [
    './index.html',
    './src/ui/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // surfaces
        background: token('background'),
        card: token('card'),
        popover: token('popover'),
        muted: token('muted'),
        accent: token('accent'),
        // lines
        border: token('border'),
        input: token('input'),
        'border-strong': token('border-strong'),
        // text
        foreground: token('foreground'),
        'muted-foreground': token('muted-foreground'),
        'subtle-foreground': token('subtle-foreground'),
        // brand + status
        primary: {
          DEFAULT: token('primary'),
          hover: token('primary-hover'),
          foreground: token('primary-foreground'),
        },
        destructive: {
          DEFAULT: token('destructive'),
          foreground: token('destructive-foreground'),
        },
        success: token('success'),
        warning: token('warning'),
        info: token('info'),
        ring: token('ring'),
        // app frame
        sidebar: token('sidebar'),
        'sidebar-hover': token('sidebar-hover'),
        'sidebar-active': token('sidebar-active'),
        'sidebar-foreground': token('sidebar-foreground'),
        'sidebar-active-foreground': token('sidebar-active-foreground'),
        // chat bubbles (Zalo: incoming white / outgoing #e5f1ff in light)
        'bubble-in': token('bubble-in'),
        'bubble-out': token('bubble-out'),
        'bubble-in-border': token('bubble-in-border'),
        'bubble-out-border': token('bubble-out-border'),
        // active / selected row (Zalo: B15 #e5f1ff in light). Keep after muted/accent so hover:bg-selected wins.
        selected: token('selected'),
        // legacy brand colours still referenced by a few components
        zalo: {
          blue: '#0068ff',
          'blue-dark': '#0052cc',
          'blue-light': '#e8f4ff',
        },
      },
      borderColor: {
        DEFAULT: token('border'),
      },
      ringColor: {
        DEFAULT: token('ring'),
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
