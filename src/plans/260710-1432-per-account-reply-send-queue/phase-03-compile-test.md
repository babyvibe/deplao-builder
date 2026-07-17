# Phase 03 — Compile-check + Test

## Mục tiêu
Đảm bảo không lỗi biên dịch, self-check pass.

## Bước
1. `npx tsc --noEmit -p tsconfig.json` — không lỗi type ở file đã sửa.
   (Nếu repo lỗi sẵn ở file khác không liên quan → ghi nhận, không đụng.)
2. Chạy test AccountSendQueue: `npx jest AccountSendQueue` (jest đã cấu hình sẵn, xem jest.config.js).
3. Fake timers cho test delay → không phải chờ thật.

## Success criteria
- tsc pass (file mới + file sửa).
- 4 test case pass.

## Unresolved questions
- Delay per-node hay per-account-global? → Đã chốt PER-NODE theo yêu cầu user (setting nằm ở task gửi tin trong wf).
- FB send (fb.action.sendMessage) có cần queue không? → Phase này CHỈ làm Zalo (đúng scope user hỏi). FB để sau nếu cần.
