/**
 * "Tạo task" từ tin nhắn (chuột phải một tin, hoặc chọn nhiều tin rồi bấm ở thanh dưới): mở popup tạo task của Quản lý
 * công việc (TaskEditorDrawer) điền sẵn tiêu đề, hạn (ngày giờ đọc trong tin) và nội dung = chữ + ảnh của các tin
 * (lib/chat/erp/messageToErp.taskDraftFromMessages, ảnh: lib/chat/erp/messageTaskImages). Ảnh đọc xong (vài giây) mới mở
 * popup; ảnh không đọc được thì nội dung ghi "[Ảnh]".
 */
import React, { useEffect, useState } from 'react';
import TaskEditorDrawer, { type TaskEditorInitial } from '@/components/erp/tasks/TaskEditorDrawer';
import { Spinner } from '@/components/common/PageLoading';
import { taskDraftFromMessages, type ErpSourceContext, type ErpSourceMessage } from '@/lib/chat/erp/messageToErp';
import { messageImageCaption, messageImageSource, messageImagesForTask } from '@/lib/chat/erp/messageTaskImages';

export function QuickTaskFromMessages({ msgs, sources, ctx, onClose }: {
  msgs: any[];
  /** Chữ / người gửi / giờ của từng tin (cùng thứ tự `msgs`). */
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
        // Tin ảnh: chữ = chú thích (không phải "[Tin nhắn]"); ảnh không đọc được → vẫn ghi lại là có ảnh
        return { ...source, text: messageImageCaption(msg) || (loaded.length ? '' : '[Ảnh]'), images: loaded };
      }), ctx);
      setInitial(draft);
    })();
    return () => { alive = false; };
    // Một lần lúc mở (danh sách tin không đổi trong lúc popup mở)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!initial) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-2xl">
          <Spinner size={4} />
          Đang lấy nội dung tin nhắn…
        </div>
      </div>
    );
  }
  return <TaskEditorDrawer initial={initial} onClose={onClose} />;
}
