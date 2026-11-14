/**
 * Small flag for a UI language (TopBar language menu). Drawn as SVG: Windows has no flag emoji (🇻🇳 shows as "VN").
 * Languages without a simple flag (or where a flag would pick a side, e.g. zh-TW) get a neutral code badge.
 */
import React, { useId } from 'react';

function starPoints(cx: number, cy: number, outer: number, inner: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (-90 + i * 36) * (Math.PI / 180);
    const r = i % 2 === 0 ? outer : inner;
    points.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(' ');
}

/** Horizontal (h) or vertical (v) stripes, equal width unless `weights` is given. */
function Stripes({ colors, dir = 'h', weights }: { colors: string[]; dir?: 'h' | 'v'; weights?: number[] }) {
  const w = weights || colors.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  let at = 0;
  return (
    <>
      {colors.map((color, i) => {
        const size = (w[i] / total) * (dir === 'h' ? 20 : 30);
        const rect = dir === 'h'
          ? <rect key={i} x={0} y={at} width={30} height={size + 0.05} fill={color} />
          : <rect key={i} x={at} y={0} width={size + 0.05} height={20} fill={color} />;
        at += size;
        return rect;
      })}
    </>
  );
}

function UnionJack() {
  const clip = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
      <clipPath id={`uj${clip}`}><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" /></clipPath>
      <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" clipPath={`url(#uj${clip})`} stroke="#C8102E" strokeWidth="4" />
      <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
    </svg>
  );
}

function FlagShapes({ code }: { code: string }): React.ReactElement | null {
  switch (code) {
    case 'vi':
      return (<><rect width="30" height="20" fill="#DA251D" /><polygon points={starPoints(15, 10, 6, 2.4)} fill="#FFDA00" /></>);
    case 'zh-CN':
      return (
        <>
          <rect width="30" height="20" fill="#EE1C25" />
          <polygon points={starPoints(5.5, 5.5, 3.2, 1.25)} fill="#FFDE00" />
          <polygon points={starPoints(11, 2, 1.05, 0.42)} fill="#FFDE00" />
          <polygon points={starPoints(13, 4.2, 1.05, 0.42)} fill="#FFDE00" />
          <polygon points={starPoints(13, 7.2, 1.05, 0.42)} fill="#FFDE00" />
          <polygon points={starPoints(11, 9.4, 1.05, 0.42)} fill="#FFDE00" />
        </>
      );
    case 'ja':
      return (<><rect width="30" height="20" fill="#fff" /><circle cx="15" cy="10" r="6" fill="#BC002D" /></>);
    case 'th':
      return <Stripes colors={['#A51931', '#F4F5F8', '#2D2A4A', '#F4F5F8', '#A51931']} weights={[1, 1, 2, 1, 1]} />;
    case 'id':
      return <Stripes colors={['#CE1126', '#fff']} />;
    case 'fr':
      return <Stripes dir="v" colors={['#002395', '#fff', '#ED2939']} />;
    case 'de':
      return <Stripes colors={['#000', '#DD0000', '#FFCE00']} />;
    case 'it':
      return <Stripes dir="v" colors={['#009246', '#fff', '#CE2B37']} />;
    case 'nl':
      return <Stripes colors={['#AE1C28', '#fff', '#21468B']} />;
    case 'ru':
      return <Stripes colors={['#fff', '#0039A6', '#D52B1E']} />;
    case 'pl':
      return <Stripes colors={['#fff', '#DC143C']} />;
    case 'es':
      return <Stripes colors={['#AA151B', '#F1BF00', '#AA151B']} weights={[1, 2, 1]} />;
    default:
      return null;
  }
}

export default function LanguageFlag({ code, className = 'w-[18px] h-3' }: { code: string; className?: string }) {
  const isUk = code === 'en';
  const shapes = isUk ? null : FlagShapes({ code });
  if (!isUk && !shapes) {
    return (
      <span className={`${className} inline-flex items-center justify-center rounded-[2px] bg-muted text-[7px] font-bold uppercase leading-none text-muted-foreground ring-1 ring-black/10`}>
        {code.split('-')[0].slice(0, 2)}
      </span>
    );
  }
  return (
    <span className={`${className} inline-block overflow-hidden rounded-[2px] ring-1 ring-black/10 shrink-0`} aria-hidden>
      {isUk ? <UnionJack /> : <svg viewBox="0 0 30 20" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">{shapes}</svg>}
    </span>
  );
}
