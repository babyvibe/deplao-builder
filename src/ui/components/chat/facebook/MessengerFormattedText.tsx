/**
 * Messenger text with its formatting (bold, italic, strikethrough, code, code blocks, quotes), the way Messenger draws the
 * markers typed in the text (shared/facebook/messengerFormatting.ts). Plain parts and the inside of bold / italic /
 * strikethrough / quotes keep @mentions, links and the search highlight (TextWithMentions); code is shown as typed.
 * A text without formatting is drawn exactly as before.
 */
import React from 'react';
import { TextWithMentions } from '../messages/ChatWindowBubbles';
import type { MentionRange } from '@/lib/chat/messages/messageParser';
import { isMessengerBlockFormat, parseMessengerFormatting, type MessengerFormatRange } from '../../../../shared/facebook/messengerFormatting';

type TextProps = React.ComponentProps<typeof TextWithMentions>;

/** Mention ranges inside [from, to), moved to start at `from`. */
function mentionsWithin(ranges: MentionRange[] | undefined, from: number, to: number): MentionRange[] | undefined {
  if (!ranges?.length) return undefined;
  const inside = ranges
    .filter(r => r.offset >= from && r.offset + r.length <= to)
    .map(r => ({ ...r, offset: r.offset - from }));
  return inside.length ? inside : undefined;
}

const CODE_CLASS = 'font-mono text-[0.92em] rounded px-1 bg-black/10 dark:bg-white/10';

export default function MessengerFormattedText(props: TextProps) {
  const { text, mentionRanges } = props;
  const ranges = React.useMemo(() => parseMessengerFormatting(text), [text]);
  if (!ranges.length) return <TextWithMentions {...props} />;

  const part = (from: number, to: number, key: string): React.ReactNode =>
    to > from ? <TextWithMentions key={key} {...props} text={text.slice(from, to)} mentionRanges={mentionsWithin(mentionRanges, from, to)} /> : null;

  const formatted = (range: MessengerFormatRange, key: string): React.ReactNode => {
    const inner = text.slice(range.contentStart, range.contentEnd);
    switch (range.format) {
      case 'codeBlock':
        return (
          <pre key={key} className="font-mono text-[0.9em] whitespace-pre-wrap break-words rounded-md px-2 py-1.5 my-1 bg-black/10 dark:bg-white/10">
            <code>{inner.replace(/\n$/, '')}</code>
          </pre>
        );
      case 'inlineCode':
        return <code key={key} className={CODE_CLASS}>{inner}</code>;
      case 'blockQuote':
      case 'inlineQuote':
        return (
          <span key={key} className="block border-l-2 border-current pl-2 opacity-80">
            {part(range.contentStart, range.contentEnd, `${key}-q`)}
          </span>
        );
      case 'bold':
        return <strong key={key} className="font-bold">{part(range.contentStart, range.contentEnd, `${key}-b`)}</strong>;
      case 'italic':
        return <em key={key} className="italic">{part(range.contentStart, range.contentEnd, `${key}-i`)}</em>;
      case 'strike':
        return <del key={key} className="line-through">{part(range.contentStart, range.contentEnd, `${key}-s`)}</del>;
      default:
        return part(range.start, range.end, key);
    }
  };

  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    const block = isMessengerBlockFormat(range.format);
    // A block starts on its own line: the line break before / after it is not drawn again
    let plainEnd = range.start;
    if (block && plainEnd > cursor && text[plainEnd - 1] === '\n') plainEnd--;
    pieces.push(part(cursor, plainEnd, `p${index}`));
    pieces.push(formatted(range, `f${index}`));
    cursor = range.end;
    if (block && text[cursor] === '\n' && !text.slice(range.start, range.end).endsWith('\n')) cursor++;
  });
  pieces.push(part(cursor, text.length, 'tail'));
  return (
    <span className="whitespace-pre-wrap select-text break-words" style={{ overflowWrap: 'break-word', wordBreak: 'normal' }}>
      {pieces}
    </span>
  );
}
