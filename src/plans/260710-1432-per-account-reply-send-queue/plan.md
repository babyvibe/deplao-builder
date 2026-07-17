# Plan: Hàng đợi gửi tin theo tài khoản (Per-Account Send Queue)

## Vấn đề
Khi nhiều khách nhắn cùng lúc vào **cùng 1 tài khoản Zalo**, `WorkflowEngineService.executeWorkflow()`
được gọi song song (fire-and-forget, `WorkflowEngineService.ts:434`) và **không có giới hạn**.
Các node gửi tin (`zalo.sendMessage`, `zalo.sendImage`, `zalo.sendFile`, `zalo.sendMedia`)
gọi `api.sendMessage()` gần như đồng thời → 1 tài khoản bắn hàng loạt tin trong 1-2s → Zalo nghi spam → khóa.

Debounce hiện có (`ts:366`) chỉ gom tin **cùng thread**, không kiểm soát tốc độ gửi **giữa các thread**.
Token bucket trong `CRMQueueService` chỉ áp cho campaign outbound, KHÔNG áp cho auto-reply.

## Giải pháp (KISS)
Thêm module `AccountSendQueue`: mỗi `zaloId` một hàng đợi tuần tự (promise-chain).
Mọi lời gọi gửi tin của workflow đi qua queue → tin ra **lần lượt**, giữa 2 tin của **cùng account**
chờ delay ngẫu nhiên `min..max` giây (mặc định 1-3s). Các account khác nhau chạy **song song**.

Delay cấu hình tại **node gửi tin** trong workflow (đúng yêu cầu user: "trong wf có task gửi tin thì
có setting thời gian cách nhau"). Nhiều workflow cùng 1 account → chung 1 hàng đợi → không đụng nhau.

## Phạm vi
- CHỈ đụng đường gửi tin Zalo trong workflow auto-reply.
- KHÔNG đụng `CRMQueueService` (đã có cơ chế riêng).
- KHÔNG đổi debounce logic.

## Phases
| Phase | File | Nội dung | Status |
|-------|------|----------|--------|
| 01 | [phase-01](phase-01-account-send-queue-module.md) | Module `AccountSendQueue` + self-check | ☐ |
| 02 | [phase-02](phase-02-integrate-workflow-engine.md) | Tích hợp vào các node gửi tin + UI setting delay | ☐ |
| 03 | [phase-03](phase-03-compile-test.md) | Compile-check + test | ☐ |

## Files sẽ đụng
- **TẠO:** `src/services/workflow/AccountSendQueue.ts`
- **TẠO:** `src/services/workflow/__tests__/AccountSendQueue.test.ts`
- **SỬA:** `src/services/workflow/WorkflowEngineService.ts` (bọc các node gửi tin qua queue)
- **SỬA:** `src/ui/components/workflow/NodeConfigPanel.tsx` (thêm 2 ô delayMin/delayMax cho node gửi tin)
- **SỬA:** `src/ui/components/workflow/workflowConfig.ts` (default config)

## Success criteria
- 200 tin từ 200 thread cùng 1 account → gửi tuần tự, mỗi tin cách 1-3s (không bắn đồng thời).
- 2 account khác nhau → 2 hàng đợi song song, không cản nhau.
- `tsc` không lỗi. Self-check pass.
- Không đổi hành vi khi delay = 0 (backward compatible).
