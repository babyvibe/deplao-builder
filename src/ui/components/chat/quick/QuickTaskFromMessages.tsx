/**
 * "Tạo task" (Create task) from a message (right-click one message, or select several and click in the bottom bar): opens the Task management popup
 * (TaskEditorDrawer) with the title, due date (date and time read from the message) and content prefilled = the text + images of the messages
 * (lib/chat/erp/messageToErp.taskDraftFromMessages, images: lib/chat/erp/messageTaskImages). The popup opens only after the images are read (a few seconds);
 * images that cannot be read are written as "[Ảnh]" (Image).
 */
import React, { useEffect, useState } from 'react';
import TaskEditorDrawer, { type TaskEditorInitial } from '@/components/erp/tasks/TaskEditorDrawer';
import { Spinner } from '@/components/common/PageLoading';
import { taskDraftFromMessages, type ErpSourceContext, type ErpSourceMessage } from '@/lib/chat/erp/messageToErp';
import { messageImageCaption, messageImageSource, messageImagesForTask } from '@/lib/chat/erp/messageTaskImages';
import { trx } from '@/lib/i18n/trx';
import { tr } from '../../../../shared/i18n';

export function QuickTaskFromMessages({ msgs, sources, ctx, onClose }: {
  msgs: any[];
  /** Text / sender / time of each message (same order as `msgs`). */
  sources: ErpSourceMessage[];
  ctx: ErpSourceContext;
  onClose: () => void;
}) {
  const [initial, setInitial] = useState<TaskEditorInitial | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const images = await messageImagesForTask(msgs);
      if (!alive) return;
      const draft = taskDraftFromMessages(msgs.map((msg, index) => {
        const source = sources[index];
        if (!messageImageSource(msg)) return source;
        const loaded = images.get(String(msg.msg_id)) || [];
        // Image message: text = caption (not "[Tin nhắn]" (Message)); an image that cannot be read still records that there is an image
        return { ...source, text: messageImageCaption(msg) || (loaded.length ? '' : tr('[Ảnh]')), images: loaded };
      }), ctx);
      setInitial(draft);
    })();
    return () => { alive = false; };
    // Once when opened (the message list does not change while the popup is open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!initial) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-2xl">
          {trx('<0/>Đang lấy nội dung tin nhắn…', { 0: <Spinner size={4} /> })}
        </div>
      </div>
    );
  }
  return <TaskEditorDrawer initial={initial} onClose={onClose} />;
}
