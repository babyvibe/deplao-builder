/**
 * Video message content: a local file → player frame (Telegram auto-plays small files silently); Zalo with no local file → cover image +
 * playback from the CDN; Telegram not downloaded yet → download on click. Caption (clickable link / @name), Telegram link card with a video.
 */
import { isFacebook, isTelegramUser, isZalo } from '@/lib/channels/channelHelper';
import { getLocalMediaPath } from '@/lib/media/mediaResolver';
import FBVideoThumb from '../../media/FBVideoThumb';
import { ZaloRemoteVideoThumb } from '../../zalo/messages/ZaloMediaExpiry';
import { getMentionRanges } from '@/lib/chat/messages/messageParser';
import { getTelegramVideoMedia, TelegramVideoPending, TextWithMentions } from '../../messages/ChatWindowBubbles';
import { getTelegramWebpageMeta, TelegramLinkPreviewCard, TelegramPreviewRefresh } from '../../telegram/messages/TelegramLinkPreview';
import type { MessageRowContext, RowLocals } from './rowContext';

/** Telegram video that auto-plays silently in the chat window: only small files (= downloaded automatically), like Telegram. */
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
  // Zalo has no local file (e.g. a message synced from the phone) → thumbnail + playback from the CDN,
  // shows "Video đã hết hạn" (Video expired) when Zalo no longer keeps the file
  const videoNode = !videoPath && isZalo(msg.channel)
    ? <ZaloRemoteVideoThumb msg={msg} onPlay={() => openVideoPlayer(msg)} />
    // Telegram has no file: download on click (≤ 10 MB downloads automatically), then open the player. Before, clicking did nothing
    : !videoPath && isTelegramUser(msg.channel)
      ? <TelegramVideoPending msg={msg} onPlay={(downloaded) => openVideoPlayer(downloaded)} />
      : (() => {
          // Telegram: frame at the real aspect ratio + a blurred cover image while the first frame is captured (matches the not-yet-loaded state)
          const tgVideo = isTelegramUser(msg.channel) ? getTelegramVideoMedia(msg) : null;
          return (
            <FBVideoThumb videoPath={videoPath} onPlay={() => openVideoPlayer(msg)} dimsMsg={msg}
              width={tgVideo?.width || undefined} height={tgVideo?.height || undefined}
              placeholderSrc={tgVideo?.thumb || undefined}
              autoPlayInline={!!tgVideo && tgVideo.size > 0 && tgVideo.size <= TELEGRAM_INLINE_AUTOPLAY_MAX_BYTES}
              duration={tgVideo?.duration || undefined} />
          );
        })();
  // Link preview with a video (e.g. fxTikTok): link on top, site name / title / description card wrapping the video, like Telegram
  const videoWebpage = isTelegramUser(msg.channel) ? getTelegramWebpageMeta(msg) : null;
  // Caption: clickable link / @name (previously plain text)
  const captionNode = videoCaption ? (
    <TextWithMentions text={videoCaption} channel={msg.channel} allContacts={contactList} groupMembersList={groupMembers}
      mentionRanges={getMentionRanges(msg.attachments)}
      highlight={searchHighlightQuery}
      onMentionClick={(uid, e) => setUserProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })} />
  ) : null;
  // Old record (video link without a card / missing title): ask Telegram to fill it in when shown, batched
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
