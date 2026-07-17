# Phase 02 — Tích hợp vào WorkflowEngine + UI

## Mục tiêu
Cho mọi node gửi tin Zalo trong workflow đi qua `AccountSendQueue`, dùng delay cấu hình ở node.

## Điểm chèn
Trong `executeNode()` (`WorkflowEngineService.ts:989`), các case gửi tin:
- `zalo.sendMessage` (ts:1010)
- `zalo.sendImage` (ts:1102)
- `zalo.sendFile` (ts:1126)
- `zalo.sendMedia` (ts ~1240)

Hiện mỗi case tự `await api.sendMessage(...)`. Bọc lại: thay vì gọi thẳng, đẩy qua
`AccountSendQueue.getInstance().enqueue(ctx.pageId, () => <body gửi cũ>, minMs, maxMs)`.

Account key = `ctx.pageId` (đã là zaloId của workflow, xem ts:701).

## Cách bọc gọn nhất (DRY)
Thêm 1 helper private trong class:
```
private enqueueSend<T>(cfg, ctx, task: () => Promise<T>): Promise<T> {
  const minS = Number(cfg.sendDelayMinSeconds ?? 0);
  const maxS = Number(cfg.sendDelayMaxSeconds ?? 0);
  return AccountSendQueue.getInstance().enqueue(
    ctx.pageId, task, minS * 1000, maxS * 1000
  );
}
```
Mỗi case gửi: `return this.enqueueSend(cfg, ctx, async () => { ...body gửi cũ... });`

Lưu ý: body gửi cũ đã bao gồm typing-effect delay nội bộ (ts:1028-1034). Giữ nguyên trong task —
những delay đó là hiệu ứng "đang gõ" trong 1 lần trả lời, còn queue delay là khoảng cách GIỮA các
lần trả lời khác nhau của cùng account. Hai thứ độc lập.

## Backward compatible
- Node cũ chưa có `sendDelayMinSeconds` → `?? 0` → min=max=0 → queue chạy tuần tự nhưng KHÔNG chờ.
  (Vẫn khác hành vi cũ 1 chút: giờ tuần tự thay vì song song. Đây là cải thiện mong muốn,
   và không delay nên không chậm cảm nhận được.)

## UI
`NodeConfigPanel.tsx` — tìm block config của `zalo.sendMessage` (và các node gửi khác). Thêm 2 field:
```
{ key: 'sendDelayMinSeconds', label: 'Giãn cách gửi tối thiểu (giây)', type: 'number' }
{ key: 'sendDelayMaxSeconds', label: 'Giãn cách gửi tối đa (giây)', type: 'number' }
```
Ghi chú UI: "Áp dụng khi nhiều khách nhắn cùng lúc trên cùng 1 tài khoản — tin gửi lần lượt, cách nhau khoảng này."

`workflowConfig.ts` — thêm default `sendDelayMinSeconds: 1, sendDelayMaxSeconds: 3` cho
`zalo.sendMessage`, `zalo.sendImage`, `zalo.sendFile`, `zalo.sendMedia`.

## Todo
- [ ] import AccountSendQueue vào WorkflowEngineService
- [ ] thêm helper enqueueSend
- [ ] bọc 4 case gửi tin
- [ ] thêm UI field + default config
