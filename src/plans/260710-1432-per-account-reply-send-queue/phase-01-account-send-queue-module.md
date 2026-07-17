# Phase 01 — Module AccountSendQueue

## Mục tiêu
Một class quản lý hàng đợi gửi tin tuần tự theo `zaloId`. Không phụ thuộc gì vào Zalo API —
nhận vào 1 hàm `task: () => Promise<T>`, đảm bảo các task **cùng account** chạy nối đuôi, giữa
2 task chờ delay ngẫu nhiên.

## Thiết kế (KISS — promise-chain, không cần setInterval)
```
enqueue(zaloId, task, minMs, maxMs):
  chain = tails.get(zaloId) ?? Promise.resolve()
  next = chain
    .then(() => task())              // chạy task hiện tại
    .finally(() => waitRandom(min,max))  // xong thì chờ delay TRƯỚC khi nhả cho task kế
  tails.set(zaloId, next.catch(()=>{})) // lỗi 1 task không đứt cả hàng
  return next                         // trả promise của task để caller await kết quả
```

Vì sao promise-chain thay vì token-bucket như CRMQueueService?
- Auto-reply là **on-demand**, không cần dispatcher loop chạy nền tốn CPU.
- CRMQueue phải dò DB pending → hợp với setInterval. Ở đây task đã nằm sẵn trong RAM.
- Ít code hơn, không cần cleanup timer.

## Chi tiết
- `tails: Map<string, Promise<any>>` — đuôi hàng đợi mỗi account.
- delay chỉ áp **giữa** các task (sau task xong, trước task kế). Task đầu tiên của account rảnh → chạy ngay.
- `min<=0 && max<=0` → không delay (backward compatible, giữ hành vi cũ).
- Chống rò rỉ: sau khi 1 task hoàn tất và nếu nó vẫn là đuôi hiện tại → xóa entry khỏi Map.

## File
- TẠO `src/services/workflow/AccountSendQueue.ts` (~70 dòng)
- Export singleton `AccountSendQueue.getInstance()` giống pattern các service khác.

## Self-check (ponytail: 1 test runnable)
- TẠO `src/services/workflow/__tests__/AccountSendQueue.test.ts`
- Test 1: 3 task cùng account chạy tuần tự (thứ tự hoàn tất = thứ tự enqueue).
- Test 2: task cùng account cách nhau >= minMs (đo timestamp).
- Test 3: 2 account khác nhau chạy song song (task account B không phải chờ account A xong hết).
- Test 4: 1 task throw không làm đứng hàng đợi (task kế vẫn chạy).

## Todo
- [ ] Viết AccountSendQueue.ts
- [ ] Viết test
- [ ] Chạy test pass
