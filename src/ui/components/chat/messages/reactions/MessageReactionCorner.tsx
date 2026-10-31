/**
 * Nút / chip cảm xúc ở góc dưới bong bóng — DÙNG CHUNG cho khung chat và phần bình luận bài đăng kênh, để thả cảm xúc ở
 * đâu cũng giống nhau (trước đây phần bình luận có nút riêng nằm xa tin, phải bấm mới mở).
 *
 * Như các app lớn: nút nằm ở góc dưới, phía TRONG khung chat (tin của mình → góc trái, tin người khác → góc phải), hiện khi
 * rê chuột lên tin; giữ chuột trên nút REACTION_PICKER_HOVER_DELAY_MS thì mở thanh chọn (lia ngang qua không tự bật), bấm
 * thì mở ngay; rời nút / thanh chọn thì đóng sau REACTION_PICKER_CLOSE_DELAY_MS. Có cảm xúc rồi: chip luôn hiện ở góc đó
 * (Telegram: mỗi cảm xúc một chip; Zalo / Facebook: một chip gộp), bấm chip = xem ai đã thả.
 * Hàng tin phải có lớp `group/msg` (nút ẩn hiện theo rê chuột), khối chứa nút phải `relative` (+ `mb-3` khi có cảm xúc).
 */
import React from 'react';
import { displayReactionEmoji } from './ReactionComponents';
import { ReactionHoverPicker } from './ReactionPicker';

/** Giữ chuột trên nút "Thả cảm xúc" bao lâu thì mới mở thanh chọn (lia ngang qua không tự bật). */
export const REACTION_PICKER_HOVER_DELAY_MS = 300;
/** Rời nút / thanh chọn bao lâu thì đóng (đi chéo / trượt ra ngoài một chút không bị mất ngay). */
export const REACTION_PICKER_CLOSE_DELAY_MS = 250;

/** Thanh chọn cảm xúc đang mở cho tin nào (một thanh tại một thời điểm) + hẹn giờ mở / đóng theo rê chuột. */
export function useReactionHoverPicker() {
  const [openId, setOpenId] = React.useState<string | null>(null);
  const openIdRef = React.useRef<string | null>(null);
  openIdRef.current = openId;
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Bấm nút: mở ngay. */
  const open = React.useCallback((id: string) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    setOpenId(id);
  }, []);

  /** Chuột vào nút / thanh chọn: tin đang mở → giữ; tin khác → mở sau khi giữ đủ lâu. */
  const arm = React.useCallback((id: string, onOpen?: () => void) => {
    if (openIdRef.current === id) {
      // Quay lại đúng tin đang mở (đi chéo giữa nút và thanh chọn): giữ thanh chọn
      if (closeTimer.current) clearTimeout(closeTimer.current);
      return;
    }
    // Tin khác: thanh chọn đang mở (nếu có) vẫn đóng theo hẹn; tin này mở sau khi giữ đủ lâu
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpenId(id);
      onOpen?.();
    }, REACTION_PICKER_HOVER_DELAY_MS);
  }, []);

  /** Chuột rời: chưa giữ đủ lâu → huỷ, không mở; đang mở → đóng sau một chút. */
  const scheduleClose = React.useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenId(null), REACTION_PICKER_CLOSE_DELAY_MS);
  }, []);

  /** Đóng ngay + huỷ hẹn giờ (đã chọn cảm xúc, đổi hội thoại — tin bị gỡ khỏi DOM nên không có mouseleave). */
  const close = React.useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    setOpenId(null);
  }, []);

  React.useEffect(() => () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  return { openId, open, arm, scheduleClose, close };
}

export interface MessageReactionCornerProps {
  isSent: boolean;
  /** Cảm xúc → số lượt */
  counts: Record<string, number>;
  /** Cảm xúc mình đã thả (null = chưa) */
  myEmoji: string | null;
  /** chips = mỗi cảm xúc một chip (Telegram), summary = một chip gộp 3 cảm xúc nhiều nhất + tổng (Zalo / Facebook) */
  variant: 'chips' | 'summary';
  /** Cảm xúc đã vẽ chỗ khác (bài đăng kênh: trong khung bài) → ở đây chỉ còn nút 👍 khi rê chuột */
  hideCounts?: boolean;
  pickerOpen: boolean;
  pickerEmojis: readonly string[];
  /** Chuột vào nút / thanh chọn (hẹn giờ mở) */
  onArm: () => void;
  /** Chuột rời */
  onLeave: () => void;
  /** Bấm 👍: mở thanh chọn ngay */
  onOpenPicker: () => void;
  /** Chọn trên thanh (chọn lại cảm xúc của mình = gỡ — nơi dùng tự xử lý) */
  onPick: (emoji: string) => void;
  /** Bấm chip: xem ai đã thả ('all' = chip gộp) */
  onShowReactors: (emoji: string) => void;
}

export function MessageReactionCorner({
  isSent, counts, myEmoji, variant, hideCounts, pickerOpen, pickerEmojis, onArm, onLeave, onOpenPicker, onPick, onShowReactors,
}: MessageReactionCornerProps) {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
  const showCounts = entries.length > 0 && !hideCounts;
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return (
    <div
      className={`absolute -bottom-4 ${pickerOpen ? 'z-30' : 'z-20'} transition-opacity duration-100${!showCounts ? ' opacity-0 group-hover/msg:opacity-100' : ''}${isSent ? ' left-1.5' : ' right-1.5'}`}
      onMouseEnter={onArm}
      onMouseLeave={onLeave}
    >
      {/* Thanh chọn: hàng dọc trên / dưới nút tuỳ chỗ trống (như Telegram), cuộn được; bấm lại cảm xúc của mình = gỡ */}
      {pickerOpen && (
        <ReactionHoverPicker emojis={pickerEmojis} myEmoji={myEmoji} align={isSent ? 'left' : 'right'} onPick={onPick} />
      )}
      {showCounts && variant === 'chips' ? (
        <div className="flex items-center gap-1 select-none">
          {entries.map(([emoji, count]) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onShowReactors(emoji)}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs shadow-sm transition-colors ${
                myEmoji === emoji
                  ? 'border-blue-600 bg-muted text-foreground hover:bg-accent'
                  : 'border-input bg-muted text-foreground hover:bg-accent'
              }`}
            >
              <span>{displayReactionEmoji(emoji)}</span>
              <span className="font-medium">{count}</span>
            </button>
          ))}
        </div>
      ) : showCounts ? (
        <button
          type="button"
          onClick={() => onShowReactors('all')}
          className="flex items-center gap-0.5 bg-muted hover:bg-accent border border-input rounded-full px-1.5 py-0.5 text-xs shadow-sm select-none transition-colors"
        >
          {entries.slice(0, 3).map(([emoji]) => <span key={emoji}>{displayReactionEmoji(emoji)}</span>)}
          {total > 1 && <span className="text-foreground/80 ml-0.5 text-[11px]">{total}</span>}
        </button>
      ) : (
        <button
          type="button"
          className="w-6 h-6 bg-card hover:bg-muted border border-input rounded-full flex items-center justify-center text-sm shadow-sm transition-colors"
          title="Thả cảm xúc (bấm hoặc giữ chuột)"
          onClick={onOpenPicker}
        >👍</button>
      )}
    </div>
  );
}
