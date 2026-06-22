import React, { useState } from 'react';

interface VersionEntry {
  version: string;
  date: string;
  type: 'major' | 'minor' | 'patch' | 'hotfix';
  highlights?: string[];
  changes: {
    category: 'new' | 'improved' | 'fixed' | 'removed' | 'security';
    items: string[];
  }[];
}

// ─── Changelog data — thêm entry mới vào ĐẦU mảng khi có bản cập nhật ────────
const CHANGELOG: VersionEntry[] = [
  {
    version: '26.6.6',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '⌨️ Nâng cấp phím tắt hội thoại: Tab chuyển hội thoại, Ctrl+P ghim, Ctrl+F tìm tin, Ctrl+K tìm hội thoại, Ctrl+N ghi chú, Ctrl+S AI, Ctrl+I thông tin, Ctrl+T tag nhanh',
      '⌨️ Chuyển tài khoản nhanh: giữ Ctrl+Tab → overlay chọn nick, thả Ctrl để chọn, Esc thoát',
      '📁 Tự động xoá media cũ — cài số ngày trong Cài đặt → Tài khoản, dọn mỗi đêm lúc 3AM',
      '📡 Tăng ổn định khi gửi tin Facebook — chống trùng tin, xử lý link đúng, hạn chế mất kết nối',
      '🤖 AI model tuỳ chỉnh — nhập model name bất kỳ cho 9Router & OpenRouter',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Phím tắt hội thoại: Tab/Shift+Tab chuyển hội thoại, Ctrl+P ghim/bỏ ghim, Ctrl+K tìm hội thoại, Ctrl+F tìm tin nhắn, Ctrl+N tạo ghi chú, Ctrl+S mở AI, Ctrl+I mở thông tin, Ctrl+T ẩn/hiện tag nhanh — kèm popup tra cứu',
          'Chuyển tài khoản nhanh Ctrl+Tab: giữ Ctrl + Tab navigate, thả Ctrl để chọn, Shift+Tab prev, Esc thoát; hỗ trợ merged inbox mode (có thêm "Tất cả tài khoản")',
          'Xoá tài khoản triệt để: 2 chế độ — (1) Xoá tất cả dữ liệu: xoá sạch tin nhắn, danh bạ, khách hàng, chiến dịch, workflow, file media; (2) Chỉ xoá tài khoản: giữ nguyên dữ liệu',
          'Tự động xoá media cũ theo ngày — cài đặt số ngày riêng từng tài khoản, hệ thống tự dọn mỗi 3AM',
          'AI: custom model input cho 9Router & OpenRouter — nhập model name bất kỳ, thêm model mới (Big Pickle, Nemotron 3 Ultra, North Mini Code)',
          'Bridge Facebook: tự động kiểm tra bridge còn sống không, respawn nếu bị treo',
        ],
      },
      {
        category: 'improved',
        items: [
          'Tăng ổn định gửi tin Facebook: chống trùng tin nhắn khi bridge echo ngược, xử lý link/sticker đúng',
          'Cải thiện kết nối Facebook: giảm tình trạng mất kết nối do overflow queue, tự động chuyển qua bridge',
          'Settings: tách giao diện quản lý tài khoản riêng, thêm cài đặt xoá media cho từng tài khoản',
        ],
      },
    ],
  },
  {
    version: '26.6.5',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🖱️ Kéo chuột chọn nhiều tin nhắn — giữ và kéo qua nhiều tin để chọn hàng loạt',
      '✏️ Sửa tên gợi nhớ trực tiếp từ ChatHeader — popup sửa alias nhanh, đồng bộ Zalo API',
      '🎞️ Facebook xử lý hiển thị tin nhắn trích dẫn, video, gif ổn định hơn',
      '🤖 AI hỗ maxTokens tuỳ chỉnh, suggestions 1000 tokens — sử dụng 9Router mượt mà hơn',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Kéo chuột chọn nhiều tin nhắn: pointerdown → drag → pointerup để chọn range tin nhắn, suppress click ngay sau drag',
          'Sửa tên gợi nhớ trực tiếp từ ChatHeader — popup AliasEditPopup, gọi changeFriendAlias + setContactAlias, đồng bộ realtime',
          'Ghim hội thoại local cho Facebook & các kênh không có Zalo API pin — dùng local_pinned_conversations, hiển thị trong GroupInfoPanel + ConversationInfo',
        ],
      },
      {
        category: 'improved',
        items: [
          'Facebook GIF: phát hiện GifPlayback từ E2EE bridge (Go events.go), hiển thị GIF animation thay vì ảnh tĩnh, xử lý ảnh gửi trong container video (mimeType image/)',
          'Facebook video: loading timeout 8s với thông báo "Tải thất bại", skip URL thumbnail ảnh giả (.jpg/.png), fallback att_* keys từ downloadNonE2EEAttachments',
          'Facebook pre-fetch contact info: tự động lấy display_name + avatar từ HTML trước khi broadcast fb:onMessage, FE fallback nếu BE fetch fail',
          'Facebook contact info trong broadcast: gửi kèm contactName + contactAvatar để UI không hiển thị UID/avatar trống',
          'Facebook E2EE: await handleIncomingMessage trước khi download media — tránh race event:localPath đến trước message store',
          'Facebook E2EE bridge buffer: tăng 1MB → 50MB hỗ trợ E2EE media download (FB limit ~25MB/file)',
          'Facebook ensureConnected: safety net listener alive sai status, thêm waitForListenerReady async poll, không reconnect khi MQTT thực sự alive',
          'Facebook session: REQUIRED_SESSION_FIELDS validate trong initSession, throw error nếu thiếu FacebookID',
          'Facebook sendMessage: detect 1:1 bằng numeric threadId, parse structured AI response giống zalo.sendMessage',
          'Facebook download: Referer facebook.com cho FB CDN (tránh 403), DEBUG_DOWNLOAD logging chi tiết',
          'AI: parse response đa format (OpenAI chat completions, Completions API text, flat content, custom response), log debug keys nếu response empty',
          'AI: truyền maxTokens qua ai:chat IPC, WorkflowAIDialog dùng maxTokens=5000, suggestions tăng 500→1000 tokens',
          'Workflow Facebook send: parse structured AI response (JSON segments), auto-resolve typeChat từ trigger context',
          'AI Assistant product dedup: tránh duplicate ID trong cùng batch khi ghim sản phẩm',
          'Contact alias relay: chuyển persist alias lên trước persistRelayConversationEvent, forward trực tiếp đến renderer',
          'ZaloEvents guard: fetchContactInfo và refreshContactAlias chỉ chạy cho Zalo contacts',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi hiển thị UID thay vì tên trên tin nhắn Facebook mới — pre-fetch contact info trước broadcast, FE fallback',
          'Sửa lỗi race condition E2EE media download: event:localPath đến trước khi message có trong store → local_paths bị mất, video không play được',
          'Sửa lỗi quote_data bị mất khi MQTT echo đến trước persistSentMessage — merge quote_data trong chatStore',
          'Sửa lỗi Facebook group bridge attachments không parse được — parse attachments array từ bridge data cho non-E2EE group messages',
          'Sửa lỗi alias không đồng bộ qua relay cho nhân viên — sắp xếp thứ tự xử lý channel, forward trực tiếp',
          'Sửa lỗi AI chat không parse được response từ server không chuẩn OpenAI format — thêm fallback các format khác',
          'Sửa lỗi E2EE ảnh gửi trong container video không hiển thị — Go bridge detect mimeType image/ trong video container',
          'Sửa lỗi Facebook MQTT attachment ID âm (0, -1, -2) — synthetic ID dùng negative index thay vì hardcode 0',
          'Sửa lỗi Facebook group video không tải được — fallback att_* keys khi tìm local_paths',
          'Sửa lỗi E2EE download lỗi âm thầm — catch + log chi tiết, thông báo bridge không hỗ trợ media type',
        ],
      },
    ],
  },
  {
    version: '26.6.4',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '👤 Tự động refresh avatar Zalo khi khởi động — avatar không còn bị mờ/thiếu do CDN hết hạn',
      '✏️ Facebook E2EE: hỗ trợ xem lịch sử chỉnh sửa tin nhắn — đánh dấu "đã chỉnh sửa" + nút "Xem nội dung cũ"',
      '📞 Gợi ý danh thiếp Zalo từ SĐT trong khung chat — gõ số 0xx, tự động tra cứu và gửi danh thiếp khi Enter',
      '🖼️ Danh thiếp Zalo cải tiến — nút "Kết bạn" trực tiếp, chọn được số điện thoại, click avatar mới mở profile',
      '🚫 Facebook: admin message (pin, poll, đổi tên nhóm) hiển thị đúng dạng thông báo hệ thống',
      'ℹ️ Tự động fetch thông tin user khi vào hội thoại mới — không còn thấy "Unknown" hay avatar mặc định',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Avatar Zalo tự động refresh khi khởi động app — kiểm tra avatar URL còn hạn không (HTTP HEAD), nếu expired thì gọi Zalo API lấy URL mới, cập nhật cả tên hiển thị',
          'Facebook E2EE: hỗ trợ tin nhắn đã chỉnh sửa — lưu edit history, DB migration thêm cột edit_history + is_edited, IPC event fb:onEdit',
          'Gợi ý danh thiếp Zalo khi gõ SĐT trong khung chat — detect pattern 0xx, debounce 800ms, tra cứu local DB + Zalo findUser API + getUserInfo, Enter để gửi danh thiếp thay vì text',
          'Nút "Kết bạn" trên danh thiếp Zalo — kiểm tra trạng thái bạn bè (isFr/is_friend), gửi lời mời trực tiếp với tin nhắn mặc định',
          'Facebook E2EE: xử lý unsend tin nhắn mã hoá — lưu nội dung gốc vào recalled_content',
        ],
      },
      {
        category: 'improved',
        items: [
          'Tự động fetch tên + avatar khi vào hội thoại mới thiếu thông tin (Zalo & Facebook) — áp dụng cho ChatHeader, ConversationInfo, và deep link/notification',
          'Danh thiếp Zalo: click avatar mới mở profile (không block select text), hiển thị SĐT dùng PhoneDisplay (selectable)',
          'Refresh alias dùng getAliasList (count=5000) thay vì gọi getUserInfo từng user — nhanh hơn, không tốn quota API',
          'Facebook E2EE unsend: lưu nội dung gốc vào recalled_content để user có thể xem lại',
          'Facebook: admin message (pin, poll, group info changes) hiển thị dạng system notification centered thay vì chat bubble',
          'Cập nhật contact alias ngay lập tức trong Zustand store khi nhận từ employee relay — không cần chờ refresh',
          'Load contacts từ DB khi nhận deep link — tránh hiển thị danh sách trống trước khi kịp load',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi admin text Facebook (pin, poll, đổi tên nhóm) hiển thị thành message bình thường — giờ là centered system notification',
          'Sửa lỗi avatar Zalo bị mờ/thiếu khi CDN URL hết hạn — tự động HEAD check + refresh khi startup',
          'Sửa lỗi không hiển thị tên contact khi vào hội thoại từ deep link / thông báo desktop — tự động fetch ngay sau khi navigate',
          'Sửa lỗi Facebook alias không được update Zustand store khi nhận từ relay server',
          'Sửa lỗi nhân viên click vào hội thoại không hiển thị tin nhắn (báo "Chưa có tin nhắn nào") — thêm zaloId vào params getMessageHistory và getUserInfo khi proxy sang Boss, giúp Boss resolve đúng tài khoản Zalo cần dùng',
          'Sửa lỗi đồng bộ dữ liệu Boss → Nhân viên timeout với nhiều messages — tăng timeout requestFullSync từ 120s lên 600s, tăng timeout deltaSync từ 60s lên 600s',
          'Sửa lỗi import messages quá chậm (INSERT từng dòng) — batch 200 rows/INSERT, giảm số lần gọi db.exec(), có fallback row-by-row nếu batch lỗi',
          'Sửa lỗi sync thất bại im lặng — thêm retry 3 lần tự động + log lỗi chi tiết nếu sync không hoàn tất',
          'Sửa lỗi upload media qua tunnel timeout với ảnh lớn — tăng timeout uploadMedia từ 60s lên 120s',
          'Sửa lỗi upload nhiều ảnh/ file tuần tự — chuyển sang upload song song (Promise.all)',
        ],
      },
    ],
  },
  {
    version: '26.6.3',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🐧 Hỗ trợ Ubuntu Linux (.AppImage + .deb) — CI/CD build tự động',
      '📡 Kết nối Facebook ổn định hơn — tự động reconnect khi mất kết nối, timeout guard 15s',
      '🤖 Workflow Zalo & Facebook gửi tin đến nhiều hội thoại cùng lúc, AI gợi ý thông minh hơn',
      '📹 Xem video Facebook inline ngay trong chat — tách riêng với video Zalo',
      '📤 Zalo nhân viên: tự động upload file ảnh/video/voice lên boss trước khi proxy',
      '🐛 Sửa lỗi gửi tin Facebook 1:1, E2EE bridge timeout, video Zalo hiển thị sai',
    ],
    changes: [
      {
        category: 'new',
        items: [
          '🐧 Hỗ trợ Ubuntu/Linux — build AppImage + .deb, CI/CD tự động trên GitHub Actions, hướng dẫn cài đặt cho Linux trong README',
          '📹 Xem video Facebook inline ngay trong khung chat (FacebookVideoBubble) — không cần mở ứng dụng ngoài, hỗ trợ E2EE video',
          '➕ Kết bạn Zalo trực tiếp từ kết quả tra cứu số điện thoại trong thanh tìm kiếm toàn cục',
          '📦 Script build bridge E2EE đa nền tảng (build-bridge-e2ee.js) — tự động clone mautrix/meta, build cho Windows/Linux/macOS',
        ],
      },
      {
        category: 'improved',
        items: [
          '📡 Facebook: tự động reconnect khi service bị mất khỏi ConnectionManager (getFBServiceOrReconnect) — không còn lỗi "Account not connected" khi mạng drop rồi online lại',
          '⏱️ Facebook: timeout guard 15s cho gửi tin nhắn qua IPC — UI không bị treo vô hạn khi MQTT/API treo',
          '🔄 Facebook gửi tin nhắn: routing thông minh — 1:1 ưu tiên E2EE bridge, group ưu tiên bridge MQTT, REST fallback',
          '✅ Facebook ensureConnected() trước khi gửi — tránh gửi request qua kết nối đã chết',
          '📤 Workflow Facebook: gửi text/ảnh đến nhiều hội thoại cùng lúc (threadIds array), hỗ trợ continueOnError',
          '📤 Workflow Zalo: gửi message/image/file đến nhiều hội thoại cùng lúc (threadIds), hỗ trợ continueOnError',
          '🤖 AI gợi ý tin nhắn: prompt instruction rõ ràng hơn, thêm fallback split câu nếu AI trả sai format',
          '🔧 9Router AI: base URL placeholder sửa đúng (bỏ /v1) — tương thích với proxy 9Router',
          '🔄 Workflow: phát hiện cycle trong topological sort — log cảnh báo node bị skip',
          '🌐 Zalo IPC: resolveZaloId fallback khi auth không có cookies — gửi tin nhắn nhanh vẫn hoạt động',
          '📤 Zalo IPC Employee: tự động upload file media (ảnh, video, voice) từ máy nhân viên lên boss trước khi proxy — file cục bộ của nhân viên không tồn tại trên boss',
          '📦 Bridge E2EE: cập nhật dependencies (mautrix v0.28.1, libsignal v0.2.2, whatsmeow mới nhất)',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi gửi tin nhắn Facebook 1:1 không qua E2EE bridge khi thread chưa được đánh dấu E2EE',
          'Sửa lỗi Facebook E2EE bridge connect timeout quá dài (120s → 30s) — không block group messaging',
          'Sửa lỗi upload attachment Facebook timeout (120s → 60s) — giảm thời gian chờ khi upload',
          'Sửa lỗi workflow Facebook sendImage không gửi được ảnh đến nhiều thread (thiếu vòng lặp)',
          'Sửa lỗi video Zalo bị ảnh hưởng bởi logic Facebook video — tách riêng ZaloVideoBubble và FacebookVideoBubble',
          'Sửa lỗi MessageInput không gửi được text và ảnh Facebook (chỉ hỗ trợ Zalo)',
        ],
      },
    ],
  },
  {
    version: '26.6.2',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🔐 Đăng nhập Facebook bằng tài khoản + mật khẩu + xác thực 2FA — không cần cookie',
      '🔔 Cài đặt thông báo và âm thanh riêng theo từng tài khoản — không cần chung tất cả',
      '📡 Kết nối Facebook ổn định hơn — cải thiện duy trì phiên hoạt động',
      '🤖 Trợ lý AI tích hợp thêm OpenRouter — thêm lựa chọn model AI giá rẻ hoặc miễn phí (author kungfu321)',
      '🐛 Sửa lỗi kết nối model AI Free ở 9Router, workflow chuyển tiếp Zalo, xoá tài khoản còn sót kết nối, và kết nối Sapo',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Đăng nhập Facebook qua tài khoản + mật khẩu + secretKey 2FA — hỗ trợ xác thực hai yếu tố, không cần phải lấy cookie thủ công',
          'Cài đặt thông báo góc màn hình và âm thanh theo từng tài khoản riêng biệt — mỗi tài khoản có thể tuỳ chỉnh thông báo riêng thay vì áp dụng chung một cấu hình cho tất cả',
        ],
      },
      {
        category: 'improved',
        items: [
          'Cải thiện duy trì kết nối Facebook ổn định hơn — giảm tình trạng mất kết nối và tự động phục hồi tốt hơn',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi kết nối đến một số model AI Free ở 9Router không hoạt động',
          'Sửa lỗi workflow Zalo node chuyển tiếp không chuyển tiếp được tin nhắn & hình ảnh',
          'Sửa lỗi đã xoá tài khoản trong Cài đặt nhưng vẫn còn kết nối ngầm',
          'Sửa lỗi kết nối Sapo và cải thiện một số lỗi API tích hợp',
        ],
      },
    ],
  },
  {
    version: '26.6.1',
    date: '06/2026',
    type: 'hotfix',
    changes: [
      {
        category: 'fixed',
        items: [
          'Sửa lỗi production build không đóng gói được E2EE bridge binary',
          'Script production giờ tự động build bridge trước khi đóng gói',
        ],
      },
    ],
  },
  {
    version: '26.6.0',
    date: '06/2026',
    type: 'major',
    highlights: [
      '🤖 Hỗ trợ kênh chat Facebook Messenger (repo fbchat-v2) — đọc/gửi tin nhắn kể cả mã hoá đầu cuối',
      '⚡ Workflow mở rộng — hỗ trợ triggers và actions mới cho Facebook',
      '📊 CRM Quét dữ liệu Facebook — tìm kiếm nhóm, fanpage, bài viết theo từ khoá, quét bình luận, thành viên nhóm, thống kê & xuất Excel',
      '🤖 Trợ lý AI tích hợp thêm 9Router - dịch vụ proxy API AI cho phép bạn gọi các model giá rẻ hoặc miễn phí.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Facebook E2EE Bridge — binary Go (fbchat-bridge-e2ee.exe) xử lý mã hoá đầu cuối, build tự động qua predev',
          'Facebook E2EE: đọc & gửi tin nhắn, media, sticker, reactions trong hội thoại mã hoá',
          'Facebook: đăng nhập bằng cookie (bỏ beta), hướng dẫn lấy cookie + cảnh báo hết hạn',
          'Facebook: block/unblock user, đổi theme, tạo note, làm mới thông tin user từ HTML (tên + avatar)',
          'Facebook: upload attachment dùng manual multipart body (sửa lỗi 0KB), tải hội thoại cũ',
          'Facebook: FBUserProfilePopup, FBVideoThumb, AccountAssignmentPopup',
          'CRM Quét dữ liệu Facebook: tìm kiếm nhóm/fanpage/bài viết theo từ khoá, quét thành viên nhóm, bình luận bài viết',
          'CRM Scan: auto-pagination với mục tiêu số lượng, batch scan nhiều ID cùng lúc, thread pool',
          'CRM Scan: tab-based sessions — tạo nhiều tab quét, lưu cấu hình & kết quả, xem lịch sử, xuất Excel',
          'CRM Scan: bộ lọc nâng cao — public groups, recent posts, lọc theo năm, từ khoá bình luận, phát hiện SĐT',
          'CRM Scan: thống kê tổng quan — biểu đồ tròn tỷ lệ thành công, thanh so sánh, top tab nhiều dữ liệu, thống kê theo loại quét',
          'CRM Scan: giao diện Chrome-style tabs, tối đa 5 tab hiển thị + overflow menu, đổi tên, lưu trữ, xoá tab',
          'Workflow: Facebook triggers (message, friend request, group, reaction,...) & actions mới',
          'Workflow: TemplateVarPopup — chọn biến động từ danh sách template variables',
          'Workflow: mở rộng workflow templates và workflow config',
          'Hệ thống models module mới — account, ai, contact, crm, employee, facebook, integration, message, proxy, workflow',
          'Integration: Sửa lại giao diện và logic tích hợp AI platforms, thêm 9Router',
          'channelConfig & channelIpc — cấu hình theo từng nền tảng (Zalo, Facebook, Telegram)',
          'useChannelCapability hook — kiểm tra tính năng theo channel',
          'Trang Donate trong IntroductionSettings',
        ],
      },
      {
        category: 'improved',
        items: [
          'Workflow Engine mở rộng — xử lý Facebook events, friend request, reaction, poll, group events',
          'NodeConfigPanel — cấu hình node Facebook, template variables, HTML editor, contact picker',
          'CRM Queue: daily_start_time tách riêng khỏi daily_send_limit, áp dụng cho mọi chiến dịch',
          'CRM CampaignCreateModal: UI daily start time luôn hiển thị, logic cải tiến',
          'CRM CampaignDetail & TargetSelector: dedup phone+UID, tránh trùng SĐT/UID khi import',
          'IntegrationPage thiết kế lại — section AI platforms, saved integrations cải tiến',
          'AIAssistantService cập nhật — hỗ trợ nhiều platform AI',
          'IntroductionSettings: tách tích hợp thành POS/thanh toán/vận chuyển/AI, thêm Donate',
          'ChatHeader: làm mới avatar Facebook từ CDN, reload thông tin user từ HTML',
          'MessageInput: hỗ trợ Facebook, cập nhật UI',
          'ChatWindow: hỗ trợ Facebook E2EE, cập nhật giao diện',
          'GroupInfoPanel: xử lý Facebook group',
          'TopBar: cập nhật giao diện, hỗ trợ Facebook',
          'EmployeeService: cập nhật đồng bộ cho Facebook',
          'HttpRelayService & HttpClientService: hỗ trợ relay Facebook events',
          'appStore: thêm trạng thái cho Facebook',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Facebook attachment upload lỗi 0KB do form-data không tương thích — dùng manual multipart body',
          'CRM: sửa lỗi phone resolve treo vô hạn (thêm timeout 15s)',
        ],
      },
    ],
  },
  {
    version: '26.4.8',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '📡 Nâng cấp kết nối Boss ↔ Nhân viên — ổn định hơn, tự khôi phục khi mất kết nối, đồng bộ realtime',
      '🔧 Sửa lỗi workflow chấp nhận & từ chối kết bạn không hoạt động đúng',
    ],
    changes: [
      {
        category: 'improved',
        items: [
          'Kết nối Boss ↔ Nhân viên ổn định hơn: tự động phát hiện mất kết nối ngầm và khôi phục, giảm tình trạng nhân viên bị "mất liên lạc" mà không biết',
          'Fallback qua LAN: khi WAN/tunnel gặp sự cố, nhân viên vẫn nhận dữ liệu qua mạng nội bộ nếu cùng mạng',
          'Đồng bộ realtime nhãn, ghim tin, tin nhắn nhanh, chiến dịch CRM và ghi chú liên hệ giữa máy boss và nhân viên',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi workflow không thực thi đúng khi trigger là "Lời mời kết bạn" — chấp nhận và từ chối kết bạn giờ hoạt động bình thường',
          'Sửa lỗi tin nhắn ghim không đồng bộ giữa boss và nhân viên khi ghim/bỏ ghim'
        ],
      },
    ],
  },
  {
    version: '26.4.7',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🔗 Chiến dịch CRM: thêm mới chọn đối tượng theo UID trực tiếp',
      '🔄 Tải lại biệt danh (alias) — nút reload trên header và tự động tìm alias mỗi ngày',
      '📊 Log chiến dịch chi tiết hơn — lưu response và lỗi từng block',
      '📡 Nâng cấp kết nối SSE — exponential backoff, tự reconnect khi mất kết nối',
      '📖 Hướng dẫn sử dụng & báo lỗi mới — truy cập nhanh từ TopBar',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Chiến dịch CRM: thêm mode chọn đối tượng theo UID — nhập danh sách UID trực tiếp, tra cứu tên khi gửi',
          'Tải lại biệt danh: nút reload alias trên ChatHeader và ConversationInfo panel cho hội thoại 1-1 trên Zalo',
          'Tự động refresh alias nền mỗi 24 giờ khi mở hội thoại — giữ biệt danh luôn cập nhật',
          'Auto-fetch thông tin liên hệ khi mở hội thoại chỉ có UID (chưa có tên/avatar) — tự động lấy từ API',
          'Tự động tải lại dữ liệu (contacts, flags) sau khi đồng bộ full/delta từ workspace khác',
          'Dashboard: thêm tooltip giải thích cho nút Gộp tài khoản, Thêm workspace và Hỗ trợ khi rê chuột',
          'TopBar: thêm nút truy cập nhanh Hướng dẫn sử dụng và Báo lỗi',
          'Trang Hướng dẫn báo lỗi mới (Cài đặt → Giới thiệu → Hướng dẫn báo lỗi) — quy trình 5 bước với ví dụ mẫu',
          'Health check tự động cho workspace từ xa — kiểm tra và reconnect mỗi 60 giây',
        ],
      },
      {
        category: 'improved',
        items: [
          'Nâng cấp kết nối SSE: exponential backoff (3s → 30s cap), tự reconnect khi heartbeat fail 2 lần liên tiếp',
          'Log chiến dịch CRM: lưu chi tiết API response và error message từng block vào send history',
          'CSV export: SĐT và UID không bị Excel chuyển thành scientific notation (ép dạng text ="...")',
          'Lọc danh sách @mention — ẩn thành viên không có tên hiển thị khỏi gợi ý nhắc đến',
          'Chế độ nhân viên ổn định hơn: không tự kết nối Zalo ở workspace remote, boss sở hữu toàn bộ kết nối',
          'Điều hướng Settings: sửa thứ tự dispatch sự kiện để tab và subtab mở đúng',
          'Thanh nhãn local: nút đóng (X) và bố cục gọn hơn, mũi tên expand/collapse chuyển sang bên phải',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa click vào ảnh trong nhóm (SingleImageInGroup) không mở được trình xem ảnh',
          'Sửa lỗi điều hướng từ Dashboard/WorkspaceSwitcher sang Settings tab sai (dispatch chưa đúng thứ tự)',
        ],
      },
    ],
  },
  {
    version: '26.4.6',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '📊 Giới hạn gửi chiến dịch theo ngày — tự động dừng khi đạt giới hạn, hẹn giờ chạy tiếp ngày sau',
      '🔧 Sửa lỗi chiến dịch gửi ảnh không thành công',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Giới hạn số liên hệ gửi/ngày cho chiến dịch CRM — cài đặt số lượng tối đa và giờ bắt đầu chạy, tự động dừng khi đạt giới hạn và tiếp tục vào ngày mới. Nếu giờ đã qua hôm nay, chiến dịch chạy ngay.',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi chiến dịch CRM có nội dung ảnh (ảnh + text hoặc chỉ ảnh) không gửi được ảnh',
        ],
      },
    ],
  },
  {
    version: '26.4.5',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🔒 khoá màn hình — bảo vệ ứng dụng bằng mật khẩu, sinh trắc học và recovery key',
      '☑️ Chọn nhiều tin nhắn — chọn và chuyển tiếp/sao chép nhiều tin cùng lúc',
      '🖼️ Tự động sửa ảnh lỗi — ảnh hỏng được tải lại ngầm, không cần thao tác',
      '📞 CRM nhập SĐT nhanh hơn — không cần chờ tra cứu, tự động xử lý khi gửi',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Khoá màn hình: đặt mật khẩu bảo vệ ứng dụng, phím tắt Ctrl+Shift+L để khoá nhanh, nút khoá trên thanh tiêu đề',
          'Chọn nhiều tin nhắn: nhấn chuột phải → "Chọn tin nhắn" để chọn nhiều tin, sau đó sao chép hoặc chuyển tiếp hàng loạt',
          'Chuyển tiếp nhiều tin cùng lúc: chọn nhiều tin nhắn và nhiều người nhận, gửi lần lượt tự động',
          'Tự động phát hiện và sửa ảnh bị lỗi (ảnh trắng, 0 byte, nội dung HTML) khi mở cuộc trò chuyện',
          'Hiển thị thông báo khi ẩn ứng dụng xuống tray — cho biết app vẫn chạy ngầm và nhận tin nhắn',
        ],
      },
      {
        category: 'improved',
        items: [
          'Chiến dịch CRM: nhập số điện thoại nhanh hơn — không cần chờ tra cứu Zalo, tự động tìm người dùng khi gửi chiến dịch',
          'Chiến dịch CRM: gửi nhiều nội dung báo lỗi chính xác hơn — biết block nào gửi thành công, block nào thất bại',
          'Cài đặt bảo mật: Cài mật khẩu, Recovery Key, Tắt khoá',
          'Khi lưu ảnh về máy mà file bị lỗi, tự động tải lại từ url gốc để đảm bảo file lưu ra không bị hỏng',
          'Nhấp vào thông báo desktop mở đúng cuộc trò chuyện ổn định hơn',
          'Ngữ cảnh AI: tăng giới hạn lên 1000 tin nhắn thay vì 100',
          'Workflow: hỗ trợ biến thời gian (HH:MM) trong điều kiện so sánh lớn hơn / nhỏ hơn',
          'Workflow: import/template tự động cập nhật liên kết giữa các node',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi ảnh hiển thị trắng hoặc xoay mãi khi zoom do file ảnh bị hỏng',
          'Sửa lỗi lưu ảnh về máy (Save As) không khắc phục được file đã lỗi',
          'Sửa lỗi nhấp thông báo tin nhắn đôi khi không mở được cuộc trò chuyện',
          'Sửa lỗi biến workflow không đúng khi dùng node AI trợ lý',
          'Sửa lỗi Cloudflare Tunnel và ffmpeg không hoạt động trên bản cài đặt (asar)',
        ],
      },
    ],
  },
  {
    version: '26.4.4',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '💬 Nâng cấp chuyển tiếp tin nhắn — hỗ trợ mọi loại, thêm soạn text kèm',
      '📊 Chiến dịch CRM thông minh hơn — auto load thông tin từ tệp số điện thoại',
      '🤖 Bổ sung Gemini 3.5 & DeepSeek V4, AI template trực quan hơn',
    ],
    changes: [
      {
        category: 'improved',
        items: [
          'Chuyển tiếp tin nhắn: hỗ trợ toàn bộ loại tin nhắn (text, ảnh, file, video) thay vì chỉ text như trước, thêm ô soạn text kèm khi chuyển tiếp',
          'Chiến dịch CRM: tự động tra cứu và load thông tin khách hàng khi chọn tệp số điện thoại',
          'Log lịch sử gửi tin CRM: bổ sung cột số điện thoại bên cạnh tên khách hàng',
          'Thẻ AI trả lời: thiết kế lại giao diện cài đặt trực quan, dễ thao tác hơn',
          'Cập nhật danh sách model AI: thêm Gemini 3.5 Flash và DeepSeek V4',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi chuyển tiếp tin nhắn không hoạt động với file, ảnh, video',
          'Sửa lỗi không duyệt được thành viên nhóm Zalo',
          'Sửa lỗi copy ảnh vào clipboard không hoạt động với ảnh remote',
        ],
      },
    ],
  },
  {
    version: '26.4.3',
    date: '05/2026',
    type: 'minor',
    highlights: [
      '🌐 Kết nối nhân viên qua WAN — boss và nhân viên giờ có thể làm việc từ bất kỳ đâu, không chỉ cùng mạng LAN',
      '🔒 Nâng cấp quản lý Proxy — chọn proxy riêng cho từng tài khoản trước khi đăng nhập',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Hỗ trợ kết nối nhân viên qua WAN: Boss bật Cloudflare Tunnel — app tự tạo URL công khai an toàn, nhân viên nhập URL đó để kết nối từ xa mà không cần cùng mạng nội bộ',
          'Thêm nút "Bật Tunnel WAN" trong Cài đặt → Nhân viên → Relay Server — một click để tạo địa chỉ truy cập từ xa',
          'Thêm màn hình cài đặt Proxy trước khi đăng nhập tài khoản Zalo — hỗ trợ HTTP, HTTPS và SOCKS5',
          'Mỗi tài khoản Zalo có thể gán proxy độc lập — không ảnh hưởng đến các tài khoản khác trong cùng app, một proxy có thể gắn nhiều tài khoản.',
        ],
      },
    ],
  },
  {
    version: '26.4.2',
    date: '05/2026',
    type: 'patch',
    highlights: [
      '👥 Nâng cấp CRM: rời nhiều nhóm cùng lúc và tham gia nhóm từ link mời',
      '🐛 Sửa lỗi quét thành viên nhóm và thống kê tin nhắn theo giờ',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Thêm hành động rời nhiều nhóm hàng loạt trong tab Liên hệ CRM',
          'Thêm nút tham gia nhóm trực tiếp từ kết quả quét link nhóm',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi phân trang khi quét thành viên từ link nhóm — giờ quét đủ toàn bộ thành viên thay vì chỉ dừng ở 100',
          'Sửa lỗi biểu đồ Tin nhắn theo giờ trong Báo cáo không hiển thị số liệu',
        ],
      },
    ],
  },
  {
    version: '26.4.1',
    date: '05/2026',
    type: 'patch',
    highlights: [
      '🚀 Chiến dịch gửi tin hàng loạt nâng cấp: hỗ trợ soạn ảnh, gửi nhiều tin trong một lần và random nội dung',
      '🐛 Sửa một số lỗi liên quan đến chat và xem ảnh',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Chiến dịch gửi tin hàng loạt hỗ trợ soạn thêm tin nhắn kèm ảnh',
          'Gửi nhiều tin nhắn trong một lượt chiến dịch',
          'Tính năng random nội dung giúp tin nhắn tự nhiên hơn, giảm trùng lặp',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi thanh gợi ý sticker khi chat — cuộn chuột trên thanh sticker giờ trượt ngang tự nhiên',
          'Sửa lỗi hiển thị ảnh trong tin nhắn — giảm hiện tượng giật/nháy khi tải ảnh',
          'Sửa lỗi trình xem ảnh — không còn nháy khi mở, kéo ảnh để zoom không còn tự đóng hộp thoại',
        ],
      },
    ],
  },
  {
    version: '26.4.0',
    date: '04/2026',
    type: 'major',
    highlights: [
      '🚀 Ra mắt Deplao — nền tảng desktop vận hành bán hàng và chăm sóc khách hàng trên Zalo trong một ứng dụng duy nhất',
      '👤 Quản lý đa tài khoản Zalo, gộp nhiều tài khoản vào một hộp thư tập trung để xử lý hội thoại nhanh hơn',
      '👥 Tích hợp CRM, Campaign, Workflow, AI, Báo cáo và Tích hợp ngoài để vận hành khép kín ngay trên desktop',
      '🗂️ Bổ sung ERP nội bộ, quản lý nhân viên & workspace để boss và team phối hợp ngay trong cùng hệ thống',
      '🔒 Kiến trúc lưu dữ liệu cục bộ, đăng nhập bằng QR, ưu tiên bảo mật và quyền kiểm soát dữ liệu cho người dùng',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Ra mắt Dashboard quản lý tài khoản: theo dõi trạng thái online/offline, listener, reconnect nhanh, tìm kiếm và sắp xếp tài khoản ngay trên màn hình chính',
          'Hỗ trợ đăng nhập và quản lý nhiều tài khoản Zalo bằng QR Code trong cùng một app, lưu phiên cục bộ an toàn và chuyển đổi tài khoản tức thì',
          'Thêm chế độ Gộp tài khoản để xem và xử lý hội thoại từ nhiều Zalo trong một inbox hợp nhất, kèm bộ lọc, tìm kiếm và nhận diện tài khoản sở hữu từng hội thoại',
          'Ra mắt hộp thư tập trung với bộ lọc Tất cả / Chưa đọc / Chưa trả lời / Khác / Theo nhãn, hỗ trợ tìm kiếm theo tên, biệt danh và số điện thoại',
          'Trang chat hỗ trợ đầy đủ thao tác quan trọng: định dạng văn bản, emoji, sticker, gửi ảnh/video/file, reply, tag thành viên, tạo poll, ghi chú nhóm, nhắc nhở và gửi danh thiếp',
          'Thêm Quick Messages không giới hạn để lưu mẫu tin nhắn, gọi nhanh bằng từ khóa và dùng được cho các tình huống tư vấn lặp lại hàng ngày',
          'Hỗ trợ ghim không giới hạn tin nhắn trong hội thoại, Group Board tổng hợp ghim / ghi chú / bình chọn và panel quản lý media, video, file đính kèm',
          'Ra mắt CRM đồng bộ bạn bè Zalo, thành viên nhóm, hồ sơ liên hệ, số điện thoại, giới tính, ngày sinh, nhãn và ghi chú nội bộ trong cùng một nơi',
          'Cho phép quản lý nhãn Zalo hai chiều: tạo, đổi tên, xóa, gán/gỡ nhãn, lọc theo nhiều nhãn và dùng nhãn làm điều kiện cho workflow',
          'Bổ sung quét thành viên nhóm nâng cao, quét nhóm lớn / nhóm ẩn / nhóm chưa tham gia từ link mời để phục vụ CRM và chiến dịch',
          'Ra mắt Campaign gửi tin hàng loạt với nhiều loại hành động như gửi tin, kết bạn, mời vào nhóm, chạy hỗn hợp; có delay, tiến độ realtime, tạm dừng/tiếp tục và log chi tiết',
          'Ra mắt Workflow Engine kéo-thả không cần code với mô hình Trigger → Node → Action, hỗ trợ chạy nền 24/7 và xem lịch sử chạy để debug',
          'Workflow hỗ trợ nhiều trigger và action quan trọng: tin nhắn mới, lời mời kết bạn, sự kiện nhóm, react, cron, gửi tin, gửi ảnh/file, tìm user, lấy profile, quản lý nhóm, mute, forward, recall, poll và đọc lịch sử chat',
          'Tích hợp node Logic, Google Sheets, AI, Telegram, Discord, Email, Notion và HTTP Request để tự động hóa quy trình bán hàng, chăm sóc khách hàng và vận hành nội bộ',
          'Ra mắt hub Tích hợp với POS, vận chuyển và AI: hỗ trợ KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS, GHN, GHTK và các trợ lý AI dùng ngay trong chat hoặc workflow',
          'Bổ sung Báo cáo & Phân tích với nhiều tab: Tổng quan, Tin nhắn, Liên hệ, Nhãn, Chiến dịch, Workflow, AI và Nhân viên để theo dõi hiệu suất vận hành theo thời gian thực',
          'Ra mắt ERP nội bộ gồm Task, Calendar, Notes và phân quyền ERP để quản lý giao việc, lịch, tài liệu nội bộ và phối hợp vận hành ngay trong Deplao',
          'Ra mắt mô hình Workspace boss ↔ nhân viên với Relay Server, phân quyền module chi tiết, cấp tài khoản nhân viên và theo dõi báo cáo hiệu suất từng người',
        ],
      },
      {
        category: 'improved',
        items: [
          'Tập trung toàn bộ chat, CRM, workflow, AI, báo cáo và ERP trong một desktop app duy nhất để giảm việc chuyển đổi qua nhiều công cụ khác nhau',
          'Tối ưu quy trình xử lý hội thoại đa tài khoản bằng sidebar chuyển nhanh, bộ lọc tập trung và cơ chế tự chuyển sang đúng tài khoản khi mở từng hội thoại',
          'Tăng khả năng chăm sóc khách hàng bằng bộ lọc CRM theo loại liên hệ, nhãn, giới tính, ngày sinh, tương tác cuối và trạng thái chiến dịch',
          'Nâng cao khả năng phối hợp đội nhóm với mô hình boss quản trị tập trung, nhân viên thao tác trên máy riêng nhưng dữ liệu vẫn đồng bộ về workspace chính',
          'Tạo nền tảng mở rộng cho bán hàng đa kênh và tự động hóa dài hạn nhờ hệ thống tích hợp, workflow và báo cáo có thể kết hợp linh hoạt theo từng mô hình kinh doanh',
        ],
      },
      {
        category: 'security',
        items: [
          'Áp dụng kiến trúc dữ liệu lưu cục bộ trên máy người dùng: tin nhắn, danh bạ, CRM, cài đặt và media không đi qua server trung gian của hệ thống',
          'Đăng nhập bằng QR Code, không yêu cầu lưu mật khẩu Zalo; phiên đăng nhập và credential tích hợp được lưu theo cơ chế bảo mật trên máy',
          'Cho phép đổi thư mục lưu trữ dữ liệu, sao chép dữ liệu tự động khi migrate và chủ động sao lưu để kiểm soát an toàn dữ liệu lâu dài',
        ],
      },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TYPE_STYLES: Record<VersionEntry['type'], { label: string; cls: string }> = {
  major:  { label: 'Major',  cls: 'bg-purple-600/30 text-purple-500 border border-purple-500/30' },
  minor:  { label: 'Minor',  cls: 'bg-blue-600/30 text-blue-500 border border-blue-500/30' },
  patch:  { label: 'Patch',  cls: 'bg-gray-600/40 text-gray-500 border border-gray-500/30' },
  hotfix: { label: 'Hotfix', cls: 'bg-red-600/30 text-red-500 border border-red-500/30' },
};

const CATEGORY_STYLES: Record<string, { icon: string; label: string; cls: string }> = {
  new:      { icon: '✨', label: 'Tính năng mới',   cls: 'text-green-400' },
  improved: { icon: '⚡', label: 'Cải thiện',        cls: 'text-blue-400' },
  fixed:    { icon: '🐛', label: 'Sửa lỗi',          cls: 'text-amber-400' },
  removed:  { icon: '🗑️', label: 'Đã xóa',           cls: 'text-red-400' },
  security: { icon: '🔒', label: 'Bảo mật',          cls: 'text-purple-400' },
};

// ─── Main component ───────────────────────────────────────────────────────────
export default function ChangelogSettings() {
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(
    new Set([CHANGELOG[0]?.version]) // expand latest by default
  );

  const toggle = (version: string) => {
    setExpandedVersions(prev => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  const expandAll = () => setExpandedVersions(new Set(CHANGELOG.map(v => v.version)));
  const collapseAll = () => setExpandedVersions(new Set());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">📋 Log phiên bản</h2>
        <div className="flex gap-2">
          <button onClick={expandAll}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded-lg hover:bg-gray-700">
            Mở rộng tất cả
          </button>
          <button onClick={collapseAll}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded-lg hover:bg-gray-700">
            Thu gọn
          </button>
        </div>
      </div>

      {/* Latest badge */}
      <div className="bg-green-900/20 border border-green-700/40 rounded-xl px-4 py-2.5 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
        <span className="text-green-300 text-xs font-medium">
          Phiên bản hiện tại: <strong>v{CHANGELOG[0]?.version}</strong> — {CHANGELOG[0]?.date}
        </span>
      </div>

      {/* Entries */}
      <div className="space-y-3">
        {CHANGELOG.map((entry, idx) => {
          const isExpanded = expandedVersions.has(entry.version);
          const typeStyle = TYPE_STYLES[entry.type];
          const isLatest = idx === 0;

          return (
            <div key={entry.version}
              className={`border rounded-xl overflow-hidden transition-colors ${
                isLatest ? 'border-blue-700/50 bg-blue-900/10' : 'border-gray-700 bg-gray-800/40'
              }`}>
              {/* Header */}
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                onClick={() => toggle(entry.version)}
              >
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${typeStyle.cls}`}>
                  {typeStyle.label}
                </span>
                <span className="text-white font-bold text-sm flex-1">
                  v{entry.version}
                  {isLatest && (
                    <span className="ml-2 text-[11px] bg-green-600/30 text-green-400 border border-green-500/30 px-1.5 py-0.5 rounded-full font-normal align-middle">
                      Mới nhất
                    </span>
                  )}
                </span>
                <span className="text-gray-500 text-xs mr-2">{entry.date}</span>
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={`text-gray-500 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {/* Body */}
              {isExpanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-gray-700/50 pt-3">
                  {/* Highlights */}
                  {entry.highlights && entry.highlights.length > 0 && (
                    <div className="bg-gray-700/30 rounded-lg px-3 py-2.5 space-y-1">
                      {entry.highlights.map((h, i) => (
                        <p key={i} className="text-gray-200 text-xs font-medium">{h}</p>
                      ))}
                    </div>
                  )}

                  {/* Change categories */}
                  {entry.changes.map((group, gi) => {
                    const style = CATEGORY_STYLES[group.category];
                    return (
                      <div key={gi} className="space-y-1.5">
                        <p className={`text-xs font-semibold flex items-center gap-1.5 ${style.cls}`}>
                          <span>{style.icon}</span>
                          {style.label}
                        </p>
                        <ul className="space-y-1 pl-1">
                          {group.items.map((item, ii) => (
                            <li key={ii} className="flex items-start gap-2 text-gray-400 text-xs">
                              <span className="text-gray-600 mt-0.5 flex-shrink-0">—</span>
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
