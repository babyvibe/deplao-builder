/**
 * Nội dung tin video: file trên máy → khung phát (Telegram tự phát không tiếng khi nhỏ); Zalo chưa có file → ảnh bìa +
 * phát từ CDN; Telegram chưa tải → tải khi bấm. Chú thích (link / @tên bấm được), thẻ link có video (Telegram).
 */
import { isFacebook, isTelegramUser, isZalo } from '@/lib/channels/channelHelper';
import { getLocalMediaPath } from '@/lib/media/mediaResolver';
import FBVideoThumb from '../../media/FBVideoThumb';
import { ZaloRemoteVideoThumb } from '../../zalo/messages/ZaloMediaExpiry';
import { getMentionRanges } from '@/lib/chat/messages/messageParser';
import { getTelegramVideoMedia, TelegramVideoPending, TextWithMentions } from '../../messages/ChatWindowBubbles';
import { getTelegramWebpageMeta, TelegramLinkPreviewCard, TelegramPreviewRefresh } from '../../telegram/messages/TelegramLinkPreview';
import type { MessageRowContext, RowLocals } from './rowContext';

/** Video Telegram tự phát không tiếng trong khung chat: chỉ file nhỏ (= nhóm tự tải), như Telegram. */
const TELEGRAM_INLINE_AUTOPLAY_MAX_BYTES = 10 * 1024 * 1024;

type VideoMessageBodyProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'telegramPostMeta'>;

export function VideoMessageBody({ ctx, msg, telegramPostMeta }: VideoMessageBodyProps) {
  const { contactList, groupMembers, openVideoPlayer, searchHighlightQuery, setUserProfilePopup } = ctx;
  let videoPath = '';
  try {
    const lp = typeof msg.local_paths === 'string'
      ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
    videoPath = lp.file || lp.video || lp.main || '';
    if (!videoPath) {
      const attKey = Object.keys(lp).find(k => k.startsWith('att_'));
      if (attKey) videoPath = lp[attKey];
    }
  } catch {}
  if (!videoPath && isFacebook(msg.channel)) {
    videoPath = getLocalMediaPath(msg, 'video') || getLocalMediaPath(msg);
  }
  // Extract caption from content (Telegram video + text)
  let videoCaption = '';
  try {
    const parsed = JSON.parse(msg.content || '{}');
    videoCaption = typeof parsed === 'string' ? parsed : (parsed.title || parsed.text || parsed.caption || '');
  } catch { videoCaption = ''; }
  if (!videoCaption && msg.content && !msg.content.startsWith('{')) videoCaption = msg.content;
  // Zalo chưa có file local (vd tin đồng bộ từ điện thoại) → thumbnail + phát từ CDN,
  // hiện "Video đã hết hạn" khi Zalo không còn lưu file
  const videoNode = !videoPath && isZalo(msg.channel)
    ? <ZaloRemoteVideoThumb msg={msg} onPlay={() => openVideoPlayer(msg)} />
    // Telegram chưa có file: tải khi bấm (≤ 10 MB tự tải) rồi mở trình phát — trước đây bấm không làm gì
    : !videoPath && isTelegramUser(msg.channel)
      ? <TelegramVideoPending msg={msg} onPlay={(downloaded) => openVideoPlayer(downloaded)} />
      : (() => {
          // Telegram: khung theo tỉ lệ thật + ảnh bìa mờ trong lúc chụp khung hình đầu (khớp lúc chưa tải)
          const tgVideo = isTelegramUser(msg.channel) ? getTelegramVideoMedia(msg) : null;
          return (
            <FBVideoThumb videoPath={videoPath} onPlay={() => openVideoPlayer(msg)} dimsMsg={msg}
              width={tgVideo?.width || undefined} height={tgVideo?.height || undefined}
              placeholderSrc={tgVideo?.thumb || undefined}
              autoPlayInline={!!tgVideo && tgVideo.size > 0 && tgVideo.size <= TELEGRAM_INLINE_AUTOPLAY_MAX_BYTES}
              duration={tgVideo?.duration || undefined} />
          );
        })();
  // Link preview có video (vd. fxTikTok): link ở trên, thẻ tên trang / tiêu đề / mô tả bọc video — như Telegram
  const videoWebpage = isTelegramUser(msg.channel) ? getTelegramWebpageMeta(msg) : null;
  // Chú thích: link / @tên bấm được (trước đây là chữ thô)
  const captionNode = videoCaption ? (
    <TextWithMentions text={videoCaption} channel={msg.channel} allContacts={contactList} groupMembersList={groupMembers}
      mentionRanges={getMentionRanges(msg.attachments)}
      highlight={searchHighlightQuery}
      onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
  ) : null;
  // Bản ghi cũ (video link chưa có thẻ / thiếu tiêu đề): xin Telegram bù khi hiện ra, gom theo lô
  const previewRefresh = isTelegramUser(msg.channel) ? <TelegramPreviewRefresh msg={msg} /> : null;
  if (videoWebpage) {
    return (
      <div className={telegramPostMeta ? 'flex w-full flex-col px-3 pt-2' : 'flex w-[19.5rem] max-w-full flex-col'}>
        {previewRefresh}
        {captionNode && <div className="pb-1.5 text-sm break-words">{captionNode}</div>}
        <TelegramLinkPreviewCard meta={videoWebpage}>{videoNode}</TelegramLinkPreviewCard>
      </div>
    );
  }
  if (captionNode) {
    return (
      <div className={telegramPostMeta ? 'flex w-full flex-col' : 'flex flex-col max-w-xs'}>
        {previewRefresh}
        {videoNode}
        <div className={telegramPostMeta ? 'px-3 pt-2 text-sm break-words' : 'pt-1.5 text-sm break-words'}>
          {captionNode}
        </div>
      </div>
    );
  }
  return <>{previewRefresh}{videoNode}</>;
}
