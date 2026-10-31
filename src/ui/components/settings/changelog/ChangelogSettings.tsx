import React, { useState } from 'react';
import { BugIcon, ChevronDownIcon, LightningIcon, LockIcon, SparklesIcon, TrashIcon} from '@/components/common/icons';
import { Button } from '@/components/ui';
import { SettingsPage } from '../settingsUi';

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

// ─── Changelog data - thêm entry mới vào ĐẦU mảng khi có bản cập nhật ────────
const CHANGELOG: VersionEntry[] = [
  {
    version: '26.10.4',
    date: '10/2026',
    type: 'minor',
    highlights: [
      '👁️ Đọc trên điện thoại là Deplao hết chưa đọc: đọc tin Zalo trên điện thoại hoặc Zalo PC thì số chưa đọc trong Deplao tự mất.',
      '🔄 Cài bản mới không cần tắt bản cũ: Deplao cũ đang chạy ngầm tự thoát để mở bản mới.',
      '🖥️ Tự mở cùng máy tính: bật máy là Deplao chạy ngầm ở khay, không lỡ tin nhắn. Tắt được ở Cài đặt → Thông báo.',
      '📲 Báo việc qua Zalo: nhân viên nhận tin Zalo khi được giao việc, task sắp đến hạn, có đơn nghỉ phép. Bật ở Quản lý công việc → Cài đặt.',
      '⚙️ Cài đặt gọn, dễ tìm: các mục chia 4 nhóm, mọi trang cùng một kiểu, chữ ngắn hơn.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Zalo: đọc tin trên điện thoại hoặc Zalo PC thì Deplao tự bỏ số chưa đọc của hội thoại (sau khoảng 1 giây, cả chat riêng lẫn nhóm); có tin mới tới sau lúc đọc thì chỉ còn đúng số tin mới đó. Trước đây đọc ở máy khác, Deplao vẫn hiện chưa đọc.',
          'Tự mở Deplao khi bật máy (Windows, macOS, Linux), bật sẵn cho mọi máy kể cả máy cập nhật từ bản cũ: tự mở thì chạy ngầm ở khay và báo "Deplao đã mở cùng máy", vẫn nhận tin và thông báo. Tắt hoặc cho hiện cửa sổ ở Cài đặt → Thông báo → Khởi động cùng máy (lưu theo từng máy). Đã tắt Deplao ở Task Manager / Mục đăng nhập của hệ điều hành thì Deplao không tự bật lại.',
          'Quản lý công việc → Cài đặt (chủ và admin): Thông báo qua Zalo. Chọn một tài khoản Zalo của cửa hàng và loại thông báo (được giao task, task sắp đến hạn / quá hạn, mời lịch, nhắc lịch, đơn nghỉ phép, kết quả duyệt nghỉ, ghi chú được chia sẻ); nhân viên nhận tin Zalo theo SĐT trong Nhân sự (thêm / sửa SĐT ngay tại đó). Gửi lần lượt cách nhau 5 - 10 giây, mỗi người tối đa 30 tin/ngày; có Gửi thử và danh sách tin gửi gần đây, lỗi ghi rõ (vd SĐT chưa có Zalo, cần kết bạn).',
          'Ứng dụng có quyền Cloudflare (vd FinTrack) gắn được tên miền riêng ngay trong ứng dụng, không cần vào Cloudflare: chọn tên con trên tên miền đã kết nối, Deplao hỏi bạn trước khi tạo. Chỉ tạo tên con mới, không đè bản ghi DNS đang có.',
        ],
      },
      {
        category: 'improved',
        items: [
          'Hội thoại lớn mượt hơn: mỗi lần Zalo, Telegram, Facebook báo đã nhận / đã xem (dấu ✓✓), app tìm tin nhanh hơn hàng trăm lần, không còn khựng ở hội thoại khoảng 100 nghìn tin.',
          'Nhóm forum Telegram lớn: mở hoặc cuộn một topic nhanh hơn hàng trăm lần (trước đây khựng tới nửa giây mỗi lần). Mục Tin đánh dấu và danh sách thành viên nhóm lớn cũng mở nhanh hơn.',
          'Danh sách chủ đề của nhóm forum Telegram giống Telegram: biểu tượng chủ đề, "người gửi: tin mới nhất", giờ của tin mới nhất (trước đây hiện ngày tạo chủ đề nên thứ tự sai), số chưa đọc đầy đủ, chủ đề ghim ở đầu, có tin mới là cập nhật ngay.',
          'Thả cảm xúc: 6 cảm xúc hiện sẵn cùng thứ tự ở Zalo, Facebook, Telegram (tim, haha, wow, buồn, phẫn nộ, thích). Telegram không có 😮 nên dùng 😱.',
          'Thông báo công việc dễ đọc hơn: giờ dạng "09:00 31/10" thay cho dạng tuỳ máy, ghi tên người giao việc / người xin nghỉ thay cho mã nhân viên, đơn nghỉ ghi loại nghỉ và lý do. Giao lại task cho người khác thì người mới được giao cũng nhận thông báo (trước đây chỉ khi tạo task).',
          'Cài đặt gọn, dễ tìm hơn: các mục chia 4 nhóm, mọi trang cùng một kiểu, chữ ngắn hơn. Giao diện có thêm chỉnh cỡ chữ; Bảo mật mở từng việc ngay tại chỗ; mỗi proxy ghi luôn tài khoản đang dùng; Lưu trữ chỉ nhắc chuyển ổ khi dữ liệu đang ở ổ C:; hộp xoá tài khoản mặc định giữ lại dữ liệu trên máy.',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa ảnh Zalo hay báo "Không tải được ảnh" dù ảnh vẫn còn trên Zalo, phải bấm Thử tải lại mới hiện: nay ảnh hiện thẳng từ Zalo khi chưa tải được về máy, tự thử lại khi có mạng lại, một ảnh không còn bị tải trùng nhiều lần.',
          'Sửa cài bản mới khi Deplao cũ còn chạy ngầm (nút X chỉ ẩn xuống khay): bấm mở bản mới không thấy gì tới khi tắt hẳn bản cũ. Nay bản cũ tự thoát và mở bản mới (Linux .deb, AppImage, macOS).',
          'Sửa thanh thả cảm xúc bị che mất cảm xúc cuối (nhất là khi tăng cỡ chữ của app): nay luôn hiện trọn từng cảm xúc.',
          'Sửa tin có nút của Trang Facebook (vd chọn dịch vụ, đặt hàng) hiện "File đính kèm không hiển thị": nay hiện đủ chữ và nút như Messenger.',
          'Sửa tin Facebook bị tính 2 lần (chưa đọc, thông báo, workflow, sự kiện API) vì Facebook gửi mỗi tin qua 2 kết nối. Cảm xúc thả 1 lần không còn hiện "2", tin bị thu hồi giữ được nội dung gốc.',
          'Sửa chat Facebook mã hoá bỏ sót cảm xúc, sửa tin, thu hồi tới ngay sau tin (trong 5 giây); thu hồi nhanh không còn làm kết nối mã hoá khởi động lại.',
        ],
      },
    ],
  },
  {
    version: '26.10.3',
    date: '10/2026',
    type: 'minor',
    highlights: [
      '🔔 Thông báo tin nhắn ngay trong app: tin mới hiện ở góc trên bên phải (ảnh và tên tài khoản, tên hội thoại, tin 2 dòng), bấm để mở hội thoại; bật / tắt theo từng tài khoản hoặc tất cả ở chuông thông báo trên thanh tiêu đề.',
      '📅 Tin nhắn thành lịch hẹn: tin có ngày giờ ("mai 9h", "20 phút nữa", "thứ 6") hiện nút Tạo lịch hẹn ngay dưới tin như Zalo, hoặc chuột phải → Thêm vào lịch; ngày giờ điền sẵn, nội dung tin thành ghi chú. Nhắc trước: chuông trên thanh tiêu đề rung "15 phút nữa tới lịch hẹn"; tới giờ có popup như nhắc hẹn Zalo, bấm là về đúng tin.',
      '🟢 Zalo như app Zalo: trạng thái truy cập của khách, tự xoá tin nhắn (cả tin gửi từ Deplao), ẩn hội thoại bằng mã PIN; Deplao vẫn giữ mọi tin trên máy.',
      '🛍️ Gửi sản phẩm cho tài khoản Zalo Business — chọn từ danh mục, quản lý danh mục và sản phẩm ngay trong app.',
      '🔐 Cài đặt → Tài khoản gọn hơn — cài đặt của từng tài khoản hiện ngay dưới dòng tài khoản: Tự động xoá media, Quyền riêng tư Zalo (ai được nhắn tin / gọi điện, trạng thái truy cập, "Đã xem"…), Hội thoại ẩn.',
      '💬 Lọc "Chưa trả lời" và theo khoảng ngày — tìm nhanh khách đang chờ phản hồi; đánh dấu đã trả lời từng hội thoại hoặc hàng loạt mà không cần gửi tin; thư mục "Khác (lưu trữ)" rõ ràng hơn.',
      '⚡ Tìm kiếm nhanh hơn hẳn — tìm tin nhắn không còn làm đứng app với tài khoản nhiều tin, tìm được khi đang gõ dở, gõ không dấu khớp cả chữ đ.',
      '👁️ Đã đọc đồng bộ khi đang chat — tin mới trong hội thoại đang mở được báo đã đọc lên Zalo, Facebook, Telegram như app gốc; điện thoại và khách không còn thấy chưa đọc.',
      '🕒 Tin Telegram đúng thứ tự — giờ tin gửi lấy theo server Telegram, máy tính lệch giờ không còn xếp tin của bạn sau câu trả lời của khách.',
      '📥 Ảnh, video Telegram tải hội thoại đang mở trước — mở app vào hội thoại là xem được ngay, tin mới nhất có file trước, không phải chờ tải bù các hội thoại khác.',
      '🧾 Tin Telegram định dạng mới hiện đầy đủ — tiêu đề, danh sách, trích dẫn, bảng, ảnh và video thật trong tin, danh sách việc cần làm; tin cũ đã lưu thành "chưa hỗ trợ" tự sửa ở nền sau khi mở app.',
      '📢 Kênh Telegram như app Telegram — bài đăng rộng như Telegram (ảnh dọc không còn bóp chữ), lượt xem và số bình luận khớp Telegram, bấm "N bình luận" mở bình luận ngay trong khung chat để đọc, viết, trả lời; quay lại đúng bài đang xem.',
      '🚀 Mở app mượt hơn — vào hội thoại lớn có nhiều trích dẫn không còn làm app đứng hơn 10 giây; mở lại app sau 1 ngày không còn giật khi Telegram tải bù tin cũ (hội thoại đang mở được bù trước); Đồng bộ dữ liệu tự động chờ 5 phút sau khi mở app; Nhật ký ghi "[Hiệu năng]" khi app bận để dễ tìm nguyên nhân.',
      '🧩 Ứng dụng làm được nhiều hơn — tự triển khai Worker + cơ sở dữ liệu D1 lên Cloudflare của bạn, tải file và ghi âm qua SDK, dùng micro, chọn trợ lý AI trong node workflow.',
      '🛠️ Sửa lỗi — tin Zalo bị nhân đôi, kéo ảnh từ web vào khung chat, trạng thái đã trả lời, bộ lọc trên máy nhân viên, chat Facebook mã hoá đầu cuối, tin vừa xem bị tính đã đọc, nhãn kênh Telegram, nhãn Zalo Business, tìm bạn bè qua API.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Quản lý công việc từ tin nhắn: tin chữ có ngày giờ sắp tới hiện nút "Tạo lịch hẹn" ngay dưới tin (như Zalo), bấm là điền sẵn ngày giờ theo tin (tin chỉ có ngày thì bạn chọn giờ), nút tự ẩn khi đã qua giờ; chuột phải một tin → Thêm vào lịch / Lưu vào ghi chú; chọn nhiều tin (Chọn tin nhắn) thì thanh dưới có Thêm vào lịch / Lưu ghi chú. Lịch điền sẵn: tiêu đề lấy từ tin (bỏ phần ngày giờ và từ đệm như "nhé cả nhà"), ngày giờ đọc trong tin, tính từ lúc tin được gửi ("mai 9h", "9h30 sáng mai", "chiều nay 3h", "thứ 6 7h tối", "thứ 2 tuần sau", "20/11 14:00", "ngày 5 tháng 12", "mùng 5 tháng sau", "cuối tuần", "20 phút nữa", "1 tiếng rưỡi nữa", "9h kém 15", "7h30ph", "8pm", gõ không dấu cũng được; giờ 1 - 5 không kèm buổi hiểu là buổi chiều, "hẹn 8h nhé" gửi buổi tối là 20:00 tối đó; không nhầm tên người ("Mai Dũng", "chị Mai", "Mai ơi"), "hoa mai", "mai mốt", "trong 2h", "lần thứ hai", "ngày 3 lần", "24/7", địa chỉ "số 12/3"; giờ mở cửa, lịch lặp hằng ngày không hiện nút), loại Cuộc họp khi tin có chữ "họp", nhắc 15 phút trước + đúng giờ, ghi chú là nội dung các tin kèm người gửi, giờ gửi và hội thoại; lịch gắn với hội thoại và đúng tin đó. Tới giờ nhắc: popup "Đến giờ hẹn!" như nhắc hẹn Zalo (có nhạc, ghi chú, Mở hội thoại nhảy tới đúng tin; lịch không gắn hội thoại có Xem lịch), app ở nền thì thêm popup Windows / macOS và nháy taskbar, nhiều lời nhắc cùng lúc hiện lần lượt; lịch đã qua lâu (máy tắt lúc tới giờ) chỉ báo nhẹ "Đã lỡ lịch". Chi tiết lịch ở Quản lý công việc → Lịch có nút Mở hội thoại.',
          'Nhắc lịch trước giờ hẹn: tạo / sửa lịch (Quản lý công việc → Lịch, Thêm lịch hẹn nhanh, từ tin nhắn) chọn nhiều mốc nhắc: Đúng giờ, 5 phút, 15 phút, 30 phút, 1 giờ, 1 ngày (mặc định 15 phút + đúng giờ). Tới mốc nhắc trước, chuông trên thanh tiêu đề rung và đếm ngược "15 phút nữa tới lịch hẹn" tới giờ hẹn; thông báo nằm trong chuông như thông báo thường, bấm vào là đã đọc và mở hội thoại của lịch (không có thì mở Lịch); app ở nền thì thêm popup Windows / macOS. Người được mời cũng nhận (trừ người đã từ chối); sửa giờ hẹn thì nhắc lại theo giờ mới, mốc đã qua không nhắc lại; máy tắt qua nhiều mốc thì chỉ báo mốc gần giờ hẹn nhất.',
          'Thông báo tin nhắn trong app:tin mới của mọi tài khoản (Zalo, Facebook, Telegram) hiện thành thẻ ở góc trên bên phải, dưới thanh tiêu đề: ảnh và tên tài khoản (page) nhận tin, tên hội thoại, người gửi và nội dung tối đa 2 dòng (dài hơn thì "…"); bấm thẻ để mở đúng hội thoại, ✕ để tắt nhanh, rê chuột để giữ lại. Mỗi thẻ hiện 2 giây, tối đa 3 thẻ (tin mới đẩy thẻ cũ nhất ra ngay), nhiều tin của cùng hội thoại gộp vào một thẻ có số đếm nên tin tới dồn dập không làm rối màn hình. Không hiện với hội thoại đã tắt thông báo, ở thư mục Khác, hội thoại ẩn, hội thoại đang mở, tin của mình, tin tải lại hoặc đồng bộ lại; khoá app thì không hiện. Bật / tắt theo từng tài khoản hoặc cho tất cả tài khoản (áp dụng cả tài khoản thêm sau) ở chuông thông báo trên thanh tiêu đề (bấm ⚙), Cài đặt → Thông báo, và ngay dưới mỗi tài khoản ở Cài đặt → Tài khoản. Đang dùng app thì thẻ này thay cho popup của Windows / macOS (không báo 2 lần); app ở nền thì vẫn dùng popup như cũ.',
          'Zalo: xem trạng thái truy cập của khách ("Trực tuyến", "Truy cập 14:05", "Đã ẩn trạng thái truy cập") khi bấm avatar trên đầu khung chat hoặc mở chi tiết hội thoại 1:1; dòng trạng thái dưới tên trên đầu khung chat nhắc lại trạng thái đã biết.',
          'Zalo: tự xoá tin nhắn (Tắt / 1 / 7 / 14 ngày) trong chi tiết hội thoại và Quản lý nhóm, đồng bộ với Zalo; tin gửi từ Deplao vào hội thoại đang bật (chữ, ảnh, file, link, video, ghi âm, danh thiếp — trừ sticker; cả workflow, chiến dịch, API) cũng tự xoá trên Zalo như gửi từ app Zalo. Deplao vẫn giữ nguyên tin trên máy — đồng hồ cạnh tên hội thoại và cạnh giờ tin có hẹn tự xoá; tin đã quá hạn có đồng hồ gạch chéo và nhãn "(đã tự xoá trên Zalo)" thay vì "đã thu hồi".',
          'Zalo: ẩn hội thoại bằng mã PIN như app Zalo — chuột phải → Ẩn hội thoại; kính lúp của ô tìm kiếm chuyển đỏ khi có hội thoại ẩn, gõ đúng 4 số PIN vào ô tìm kiếm thì danh sách chỉ còn các hội thoại ẩn (bấm kính lúp đỏ hoặc ✕ ở dòng "Hội thoại ẩn" để ẩn lại); tự ẩn lại khi khoá app, đổi tài khoản hoặc 5 phút không thao tác; hội thoại ẩn không kêu, không thông báo, không tính chưa đọc; quên mã PIN: Cài đặt → Tài khoản → Quyền riêng tư Zalo → "Quên mã PIN? Đặt lại" (hỏi 2 lần, khoá màn hình đang bật thì nhập lại mật khẩu — Zalo có thể xoá tin của các hội thoại đang ẩn trên điện thoại, Deplao vẫn giữ); đổi / xoá mã PIN trên điện thoại thì bấm kính lúp đỏ để đọc lại từ Zalo — xoá PIN thì các hội thoại hiện lại.',
          'Zalo Business: nút "Gửi sản phẩm" trên thanh soạn tin — chọn danh mục và sản phẩm (gửi nhiều thì cách nhau 2 giây); quản lý danh mục, sản phẩm với tối đa 5 ảnh.',
          'Cài đặt → Tài khoản, ngay dưới mỗi tài khoản Zalo: Quyền riêng tư Zalo (ngày sinh, trạng thái truy cập, "Đã xem", ai được nhắn tin / gọi điện — hỏi lại trước khi chuyển sang Chỉ bạn bè, nguồn kết bạn) và Hội thoại ẩn (đặt / đổi / đặt lại mã PIN).',
          'Public API: trạng thái truy cập, tự xoá tin nhắn, quyền riêng tư Zalo và danh mục sản phẩm Zalo Business (13 thao tác mới trong tài liệu API; thêm / sửa sản phẩm nhận ảnh mới qua photo_files — file đã upload, thư viện media hoặc link).',
          'Ứng dụng (Công cụ → Ứng dụng, API & Webhook): quyền mới "Triển khai Worker và cơ sở dữ liệu D1" — ứng dụng tự dựng Worker + D1 trên tài khoản Cloudflare đã kết nối trong Deplao, chỉ với tài nguyên mang tên của ứng dụng; token Cloudflare không bao giờ đưa cho ứng dụng. Cài đặt → Internet & Đám mây hiện thêm dòng "Worker, D1 (cho ứng dụng)" — quyền không bắt buộc (Workers Scripts · Edit, D1 · Edit), thiếu thì không tính là lỗi kết nối.',
          'Ứng dụng: tải file của tin nhắn và thư viện media qua SDK (cả ghi âm Zalo, tối đa 25 MB); http.fetch đọc được file nhị phân; quyền mới "Dùng micro trong giao diện ứng dụng" và hiện ảnh từ nguồn ứng dụng khai báo (vd ảnh đại diện Zalo); node workflow của ứng dụng có ô chọn trợ lý AI ("để trống" = ứng dụng tự chọn).',
          'Public API: GET /ai/assistants/options (danh sách trợ lý để chọn — chỉ tên, nền tảng, model; không prompt, không key); /ai/chat thêm raw_system (gửi đúng messages, không ghép prompt / tri thức của trợ lý) và nhận tin dài tới 100.000 ký tự; tải file của tin nay gồm cả ghi âm Zalo (tự tải về máy nếu chưa có).',
          'Danh sách hội thoại, menu ⋮: lọc "Chưa trả lời" (hội thoại 1:1 mà tin cuối là của khách — đã đọc hay chưa đều tính) và lọc theo khoảng ngày của tin cuối (chọn Từ – Đến ngày), dùng kèm các bộ lọc khác; dòng bộ lọc đang bật có nút ✕ và số hội thoại.',
          'Đánh dấu đã trả lời không cần gửi tin: chuột phải một hội thoại (Đánh dấu đã trả lời / chưa trả lời) hoặc hàng loạt ở menu ⋮ → Đánh dấu đã trả lời hàng loạt (chọn thời gian tin cuối, xem trước số hội thoại như Tự động đánh dấu đã đọc); khách nhắn tiếp thì tự chuyển lại Chưa trả lời; máy nhân viên cũng thấy.',
          'Telegram, kênh có nhóm thảo luận: bấm thanh "N bình luận" / "Để lại bình luận" dưới bài để mở phần bình luận ngay trong khung chat như Telegram — mở đúng chỗ như Telegram (chưa đọc lần nào: từ bình luận đầu tiên, bài gốc ở trên; có bình luận mới: ngay vạch "Bình luận chưa đọc"; đã đọc hết: mới nhất), cuộn lên / xuống tự tải thêm, nút ↓ về bình luận mới nhất; bình luận đã xem được báo đã đọc lên Telegram, thanh bình luận dưới bài có chấm xanh khi có bình luận mới; ảnh đại diện và tên màu người bình luận (cả kênh tự bình luận, quản trị viên ẩn danh), bấm ảnh / tên để xem hồ sơ như trong nhóm, trả lời bình luận khác có trích dẫn; ô bình luận chính là ô soạn tin của khung chat — gửi chữ, ảnh, video, tệp, ghi âm, sticker, GIF, @nhắc tên, tin nhắn nhanh, dán / kéo thả ảnh, trả lời từng bình luận; thả cảm xúc y như khung chat (nút ở góc dưới bong bóng, giữ chuột là mở, bấm chip xem ai đã thả); chưa tham gia nhóm thảo luận thì bình luận không làm nhóm hiện trong danh sách hội thoại (như Telegram); nhóm bắt buộc tham gia thì có nút Tham gia / Gửi yêu cầu tham gia; bình luận mới tự hiện (30 giây / lần); Esc hoặc ‹ để quay lại kênh đúng chỗ đang xem.',
        ],
      },
      {
        category: 'improved',
        items: [
          'Thư mục "Khác" đổi tên thành "Khác (lưu trữ)" (biểu tượng hộp lưu trữ, giải thích rõ: không âm thanh, không thông báo, không tính chưa đọc; Telegram đã lưu trữ cũng ở đây); đang xem thì có nhãn "Khác (lưu trữ)" + ✕ để về danh sách chính; "Chuyển về Chính" đổi thành "Đưa về danh sách chính".',
          'Tìm kiếm ở danh sách hội thoại nhanh hơn hẳn: tìm tin nhắn không còn quét cả kho tin (trước đây gõ sai hoặc từ hiếm làm cả app đứng tới hàng chục giây với tài khoản nhiều tin), tìm được khi đang gõ dở ("xin ch" ra "xin chào"), gõ không dấu khớp cả chữ đ ("don hang" ra "Đơn hàng", "duc" ra "Đức"); lọc danh bạ khi gõ nhanh hơn khoảng 70 lần; từ 2 ký tự trở lên mới tìm trong tin nhắn.',
          'Mở app mượt hơn khi bật Đồng bộ dữ liệu: 5 phút đầu sau khi mở app không chạy đồng bộ tự động (trước đây có lần chụp lại bản gốc DB ngay lúc mở — DB 2,7 GB mất khoảng 1,5 phút CPU / ổ đĩa, đúng lúc giao diện đang dựng và các kênh đang đồng bộ bù); "Đồng bộ ngay" và đổi phạm vi / kho vẫn chạy ngay. Cài đặt → Nhật ký ghi "[Hiệu năng]" khi app bận liền từ 1 giây (luồng chính, IPC nào, hay giao diện) để tìm nguyên nhân khi app đứng.',
          'Mở hội thoại có nhiều trích dẫn (nhất là nhóm / kênh Telegram lớn) không còn làm app đứng: tìm tin gốc của trích dẫn trước đây quét cả hội thoại (khoảng 0,4 giây mỗi trích dẫn ở hội thoại 100 nghìn tin — lúc mở app cộng lại hơn 10 giây), nay gần như tức thì; thả cảm xúc, thu hồi, xoá tin ở hội thoại lớn cũng nhanh hơn.',
          'Mở lại app sau thời gian dài (vd 1 ngày) không còn giật, đứng từng lúc khi Telegram tải bù tin cũ: hội thoại đang mở được bù trước, việc bù tin chạy theo nhịp để nhường máy cho thao tác của bạn, danh sách hội thoại cập nhật theo lô thay vì từng tin. Kiểm tra tin mới của kênh lớn không còn quét cả kênh (trước đây app đứng 1 - 2 giây mỗi 30 - 45 giây, nay vài chục mili giây); ảnh đại diện thành viên mà Telegram không cho tải không còn bị thử lại liên tục.',
          'Cài đặt → Tài khoản: cài đặt riêng của từng tài khoản hiện ngay dưới dòng tài khoản kèm trạng thái hiện tại (Tự động xoá media: Tắt hoặc Bật · xoá media cũ hơn N ngày; Zalo thêm Quyền riêng tư Zalo, Hội thoại ẩn) — bấm dòng nào mở ngay bên dưới, không còn giấu sau nút bánh răng.',
          'Telegram: ảnh, video, file của hội thoại đang mở tải trước, tin mới nhất trước — trước đây tải theo thứ tự xếp hàng nên lúc mở app phải chờ tải bù tin cũ của mọi hội thoại khác, tin mới nhất lại có file sau cùng. Bấm tải video thì tải ngay sau lượt đang chạy; video lớn của hội thoại khác đang tải dở thì tạm nhường rồi tải lại sau; các file còn thiếu của một hội thoại xin Telegram một lần thay vì từng tin.',
          'Telegram: Deplao nói chuyện với Telegram bằng API layer 232 (như Telegram Desktop 7.3) thay vì layer 198 của thư viện GramJS — tin định dạng phong phú (tiêu đề nhiều cấp, danh sách, ô đánh dấu, trích dẫn, bảng, công thức, hàng nút…) hiện thành chữ đầy đủ, tin dài tự lấy phần còn lại; danh sách việc cần làm hiện tiêu đề + ☐ / ☑; phát trực tiếp có nhãn. Tin cũ đã lưu thành "chưa hỗ trợ" tự lấy lại từ Telegram ở nền sau khi mở app (từng lô nhỏ, không cần mở từng hội thoại), dòng xem trước của hội thoại cũng tự sửa; ảnh trong tin hiện ảnh thật (bấm để xem lớn), video / âm thanh / tệp bấm để tải rồi phát / mở ngay trong tin. Tham gia nhóm bằng link mà nhóm yêu cầu xác minh qua bot thì báo rõ cần tham gia bằng app Telegram.',
          'Telegram, kênh: bài đăng vẽ như Telegram — khung bài rộng cố định, ảnh / video / album sát mép khung; ảnh và video dọc không còn làm khung hẹp lại (hai bên là chính ảnh làm mờ, chữ có chỗ rộng); cảm xúc nằm trong khung bài, bấm để thả / gỡ; chân bài có người đăng · 👁 lượt xem · đã sửa · giờ; thanh bình luận có ảnh người bình luận gần đây. Lượt xem / số bình luận làm mới khi mở kênh và mỗi phút (trước đây là số lúc bài về nên lệch xa Telegram), số lớn viết gọn như Telegram (12.3K).',
          'Telegram: tin chuyển tiếp như Telegram. Ảnh, album, file chuyển tiếp nằm chung một khung với dòng "Chuyển tiếp từ …" (tên dài tự xuống dòng theo bề rộng ảnh, không còn kéo lệch tin); có ảnh đại diện của nguồn (chưa có ảnh thì ảnh chữ); trên tin mình gửi (bong bóng xanh), chữ "Chuyển tiếp từ" và @nhắc tên xanh sáng hơn cho dễ đọc; tin nhận giữ màu xanh cũ.',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa trạng thái đã trả lời / chưa trả lời đánh dấu sai: nay tính theo tin thật mới nhất của hội thoại (bỏ thông báo hệ thống, bản tin OA, tin mẫu), không mất khi mở lại app, tin cũ tải bù không đổi trạng thái; bộ lọc "Chưa trả lời" cũ thực chất chỉ là "Chưa đọc".',
          'Sửa máy nhân viên: lọc danh sách hội thoại (Chưa đọc, Khác, theo kênh, tìm kiếm, Chưa trả lời, theo khoảng ngày) luôn ra danh sách trống — nay lọc trên dữ liệu của máy Boss; mất kết nối Boss thì giữ danh sách đang hiện.',
          'Sửa bộ lọc danh sách hội thoại: bấm tab "Tất cả" nay bỏ mọi bộ lọc (Khác (lưu trữ), Chưa trả lời, khoảng ngày, kênh, đang xem hội thoại ẩn) và chỉ sáng khi không lọc gì — trước đây lọc khoảng ngày / kênh vẫn giữ nên bấm "Tất cả" như không có tác dụng; lọc theo kênh có nhãn ✕ như các bộ lọc khác; "Khác (lưu trữ)" lên đầu menu ⋮, bấm lại để về danh sách chính, số hội thoại trong menu đếm đủ (trước đây chỉ đếm phần đã tải nên lệch với số khi mở thư mục); bỏ lọc không còn làm danh sách nháy trống.',
          'Sửa chat Facebook mã hoá đầu cuối hiện "Lỗi - Thử lại" ở đầu khung chat mỗi lần mở — app không nhận ra hội thoại mã hoá nên cố tải tin cũ qua đường Facebook không hỗ trợ.',
          'Sửa Cài đặt → Tài khoản ghi "Zalo" cho tài khoản Telegram và Telegram Bot — nay hiện đúng tên kênh; xoá tài khoản Telegram Bot dừng bot ngay (trước đây bot vẫn nhận tin tới lần mở app sau).',
          'Sửa tài khoản Zalo Business mất nhãn "Business" sau khi đăng nhập lại bằng QR (cờ bị ghi 0 trước khi đọc gói Business) — nay giữ nguyên, tự đọc lại khi mở app / kết nối lại (tối đa 6 giờ một lần) và cập nhật ngay cả trên máy nhân viên; số điện thoại của tài khoản không còn bị xoá khi Zalo trả thiếu.',
          'Sửa tìm @username Telegram gọi Telegram ở mỗi phím gõ (dễ bị Telegram giới hạn) và đôi khi hiện nhầm người của từ khoá trước — nay chờ ngừng gõ rồi mới tìm, kết quả cũ về muộn bị bỏ qua.',
          'Sửa Nhật ký liên tục báo "Blocked zalo:getUserInfo … is not an active Zalo connection" khi nhóm Telegram có tin mới — app gọi nhầm hàm lấy thông tin người gửi của Zalo cho tài khoản Telegram (mỗi người gửi chưa rõ tên một lần / phút).',
          'Sửa đang chat mà điện thoại và khách vẫn thấy chưa đọc: tin mới vào hội thoại đang mở nay được báo đã đọc lên Telegram và Facebook (trước đây chỉ khi bấm vào hội thoại — Telegram còn trả số chưa đọc về app); Zalo "đã xem" lấy đúng tin khách gửi mới nhất (trước đây có lúc lấy tin của mình / tin hệ thống nên Zalo không nhận). Chỉ báo khi hội thoại đang hiện, cửa sổ đang mở và bạn có thao tác chuột / phím trong 1 phút — bỏ máy đi thì báo khi bạn quay lại; loạt tin liên tiếp gom thành một lần báo.',
          'Sửa tin mới của hội thoại vừa xem bị tính đã đọc (không chuông, không số chưa đọc, Zalo vẫn báo "đã xem") khi bạn đang ở trang khác (Tổng quan, CRM, Cài đặt…) — nay vẫn là chưa đọc và có thông báo như các hội thoại khác.',
          'Chuyển hội thoại bằng phím Tab, mở từ Chat nhanh hoặc từ nhắc hẹn nay cũng báo đã đọc lên Zalo / Facebook / Telegram như khi bấm trong danh sách (trước đây chỉ trên máy, hoặc chỉ Zalo).',
          'Sửa thứ tự tin khi chat nhanh trên Telegram: máy tính chạy nhanh vài giây so với giờ chuẩn thì tin bạn vừa gửi bị xếp SAU câu khách trả lời ngay và lệch phút so với Telegram Desktop — tin gửi đi (cả Telegram Bot) nay lấy giờ server Telegram, cùng giây thì xếp theo thứ tự trên Telegram; tin đã gửi trong 30 ngày qua tự xếp lại một lần sau khi mở app. Cài đặt → Nhật ký báo "[Đồng hồ]" khi đồng hồ máy lệch từ 2 giây.',
          'Sửa vào hội thoại Telegram lúc vừa mở app (hoặc mạng vừa có lại) thì ảnh, video để trống tới khi mở lại hội thoại — yêu cầu tải lúc Telegram đang kết nối nay chờ kết nối xong rồi tải (tối đa 45 giây) thay vì bỏ luôn.',
          'Sửa đồng bộ tin nhắn từ điện thoại Zalo làm tin đã gửi bị nhân đôi: điện thoại không lưu mã tin thật cho tin gửi từ máy khác (Deplao, Zalo PC) nên bản đồng bộ được thêm thành bản thứ hai — nay nhận ra cùng một tin theo người gửi + mã tin phía máy gửi và không thêm nữa.',
          'Sửa tin nhóm Zalo thỉnh thoảng hiện hai lần: Zalo giao cùng một tin hai lần với mã khác nhau — nay bỏ bản thứ hai (không lưu, không thông báo, không chạy workflow).',
          'Sửa kéo ảnh từ trang web / app khác vào khung chat không có gì xảy ra (trước đây chỉ nhận file kéo từ File Explorer) — nay tải ảnh về rồi đưa vào khay chờ gửi; thả ra ngoài khung chat không còn làm cửa sổ app mở luôn file; kéo vào ô soạn tin hay vùng tin nhắn gửi cùng một cách. App chạy bằng "Run as administrator" (Windows chặn kéo-thả từ File Explorer) thì được nhắc mở lại bình thường.',
          'Sửa Public API danh sách bạn bè Zalo (GET /accounts/:accountId/friends) với tham số search luôn trả rỗng — nay tìm theo tên (không dấu, không phân biệt hoa thường: "dao" ra "Đào") hoặc số điện thoại.',
          'Sửa bình luận bài đăng kênh Telegram sai nhiều chỗ: bình luận bị lưu lẫn vào kênh như bài đăng (thẻ "BÀI ĐĂNG KÊNH", xếp ngược, người gửi hiện "U"), thiếu bình luận vì trùng số với bài của kênh và ghi đè thông tin trả lời của các bài kênh trùng số — bình luận nay nằm ở nhóm thảo luận của kênh; bài kênh bị ghi đè tự sửa lại ở nền sau khi mở app.',
          'Sửa số bình luận của bài album trong kênh Telegram không khớp (đọc ở ảnh đầu album trong khi Telegram gắn số bình luận vào một ảnh khác).',
          'Sửa quay lại từ phần bình luận làm kênh cuộn xuống cuối — nay giữ nguyên vị trí bài đang xem.',
          'Sửa bình luận của bài đăng kênh Telegram hiện thừa ngay trong danh sách bài (giữa các bài, người gửi "U", trích dẫn "[Tin nhắn]") — bản cũ lưu bình luận vào hội thoại của kênh; nay tự chuyển về nhóm thảo luận ở nền sau khi mở app (chỉ bỏ bản trong kênh khi nhóm thảo luận đã có bản đúng; bài thật trùng số bị ghi đè cũng được lấy lại từ Telegram).',
          'Sửa ảnh / video / tệp gửi vào chủ đề của nhóm forum Telegram (chọn từ thư viện hoặc từ máy) rơi ra dòng chính của nhóm thay vì vào chủ đề; trả lời một tin trong chủ đề (cả ảnh, tệp, video) giữ đúng chủ đề và hiện trích dẫn tin được trả lời ngay.',
          'Sửa @nhắc tên trong tin Telegram chỉ là chữ: người được nhắc (nhất là người không có @username) không được Telegram báo — nay gửi kèm liên kết tới người như app Telegram, ở chat thường, chủ đề forum và bình luận bài đăng (tin có ký hiệu định dạng ** __ ~~ ` vẫn gửi như cũ); Telegram từ chối nhắc tên thì tin vẫn được gửi, chỉ không kèm liên kết.',
          'Sửa ghi âm trong hội thoại Telegram luôn báo lỗi (gửi nhầm qua đường của Zalo) — nay gửi thành tin thoại Telegram thật, có thời lượng, nghe được trên app Telegram.',
          'Sửa menu ⋮ của danh sách hội thoại bị phần bình luận bài đăng che mất; nút + Thêm tài khoản bị bóp dẹt khi có nhiều tài khoản phải cuộn.',
          'Sửa mỗi tin nhắn Facebook phát âm thanh hai lần cùng lúc và hiện 2 popup thông báo liên tiếp (hai chỗ cùng báo cho một tin); nay báo một lần, kể cả khi app ở nền mà hội thoại đó đang mở.',
          'Sửa lịch trong Quản lý công việc không bao giờ nhắc: tới giờ nhắc app không hiện gì (chỉ trang Quản lý công việc nghe và cũng không hiện); nay nhắc ở mọi trang, chỉ nhắc lịch của mình (người tạo hoặc được mời).',
          'Sửa danh sách thông báo ở chuông hiện số "0" thừa trước mỗi thông báo đã đọc / chưa đọc.',
          'Sửa cài đặt thông báo riêng của từng tài khoản (Cài đặt → Thông báo → Áp dụng cho tài khoản) mất sau khi mở lại app; chỉnh âm lượng của một tài khoản không còn tự bật lại âm thanh khi mặc định đang tắt. Cài đặt lưu trên từng máy (máy nhân viên chỉnh riêng), chỉ giữ phần khác mặc định nên đổi mặc định vẫn áp cho phần còn lại; tài khoản có cài đặt riêng ghi "(cài đặt riêng)", bấm "Dùng cài đặt mặc định" để bỏ.',
          'Sửa nút "Nhắn tin" trong hồ sơ người dùng (Telegram, Zalo, Facebook, cả trong bình luận kênh): trước đây người chưa có trong danh sách hiện mã số thay vì tên và ảnh, tin cũ không tải về, mở từ CRM có lúc lại về hội thoại cũ. Nay nút mở popup Nhắn tin nhanh để nhắn ngay mà không rời màn hình đang xem; nút "Mở hội thoại đầy đủ" trong popup mở như bấm trong danh sách. Hồ sơ người Telegram không còn bị lưu thành liên hệ Zalo.',
          'Sửa Nhắn tin nhanh (Ctrl+Shift+N) chỉ gửi được bằng tài khoản Zalo: chọn tài khoản Telegram / Facebook thì chữ, 👍, ảnh, tệp, tin nhắn nhanh đều lỗi im lặng. Nay gửi được mọi kênh (tin đang gửi, gửi lỗi, gửi lại như khung chat), tin trả lời hiện ngay trong popup và không kêu chuông, ô "Đến:" tìm cả liên hệ chưa có trong danh sách và @username Telegram. Ctrl+Shift+N không còn mở thêm ô ghi chú (Ctrl+N).',
          'Sửa Zalo mất kết nối khi mở hoặc đăng xuất Zalo PC: nay tự nối lại ngay trên cùng phiên như Zalo Web, thay vì chờ rồi đăng nhập lại cả phiên (tối đa 5 lần rồi bỏ); lần ngắt ngắn không còn hiện "bị ngắt kết nối". Bấm "Ngắt kết nối" một tài khoản Zalo nay giữ nguyên (trước đây tự đăng nhập lại sau 5 giây).',
        ],
      },
    ],
  },
  {
    version: '26.10.2',
    date: '10/2026',
    type: 'minor',
    highlights: [
      '✅ Trạng thái tin nhắn như Telegram — tin bạn gửi có dấu ✓ đã gửi, ✓✓ đã nhận, ✓✓ xanh đã xem ngay cạnh giờ (Zalo, Facebook, Telegram); rê chuột vào giờ để xem đủ ngày giờ.',
      '🎨 Khung chat kiểu Telegram cho mọi kênh — tên người gửi có màu riêng nằm trong bong bóng ở mọi loại tin, trích dẫn tô màu theo người, giờ nằm cuối dòng chữ; nhóm Telegram hiện chức vụ ở góc phải tên.',
      '🔤 Ảnh đại diện chữ thống nhất — 2 ký tự viết tắt, màu theo người / nhóm, giống nhau từ danh sách hội thoại, khung chat đến CRM và các popup.',
      '🚀 Mở lại app mượt hơn — Telegram đợi giao diện tải xong và app rảnh mới đồng bộ bù tin cũ, hết giật lúc khởi động.',
      '🔗 Link dễ đọc hơn ở giao diện Tối, email bấm được để mở ứng dụng thư; kết quả tìm SĐT Zalo có nút X để ẩn.',
      '🏷️ Gõ @ để nhắc tên như Telegram — danh sách thành viên hiện ngay kèm @username, cuộn xem đủ người; nhóm Telegram lớn tự tìm thêm trên Telegram.',
      '⏬ Video đang tải hiện tiến độ "2.1 / 5.0 MB" như Telegram — tải xong mới phát, không còn mở trình phát bị lỗi.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Dấu trạng thái cạnh giờ của tin bạn gửi, trên mọi loại tin (chữ, ảnh / video, file, thẻ): đồng hồ = đang gửi, ! đỏ = gửi lỗi, ✓ = đã gửi, ✓✓ = đã nhận, ✓✓ màu nhấn = đã xem. Zalo và Facebook (cả tin mã hoá đầu cuối) đủ 3 mức; Telegram cá nhân có đã gửi / đã xem (Telegram không có mức "đã nhận") và nhận cả khi người kia đọc lúc app đang tắt; Telegram Bot không có báo nên không hiện dấu. Trong nhóm, một người xem là tính đã xem (như Telegram). Người kia nhắn sau tin của bạn thì các tin trước đó cũng tính là đã xem (Zalo không phải lúc nào cũng báo "đã xem").',
          'Rê chuột vào giờ tin nhắn để xem đầy đủ thứ, ngày, giờ.',
          'Nhóm Telegram: chức vụ người gửi (chức vụ tự đặt, Quản trị viên, Chủ nhóm) ở góc phải dòng tên; danh sách quản trị viên được lưu, tự làm mới sau 6 giờ.',
          'Email trong tin nhắn thành link — bấm để mở ứng dụng thư (mailto:), như Telegram.',
          'Nút X ẩn kết quả tìm số điện thoại Zalo ở ô tìm kiếm hội thoại (khi đang tìm, không tìm thấy, đã tìm thấy hoặc đang chờ chọn tài khoản).',
          'Video đang tải về máy hiện tiến độ như Telegram (Telegram, Zalo, Facebook): vòng tiến độ ở giữa + "2.1 / 5.0 MB" ở góc, đang chờ lượt tải thì vòng xoay; tải xong mới phát được — bấm trong lúc tải không mở trình phát (trước đây video Zalo vừa nhận phát thẳng từ máy chủ Zalo, hay lỗi).',
        ],
      },
      {
        category: 'improved',
        items: [
          'Khung chat kiểu Telegram cho mọi kênh (Zalo, Facebook, Telegram): tên người gửi trong nhóm nằm trong bong bóng ở mọi loại tin — cả ảnh, album, file, thẻ — mỗi người một màu cố định (7 màu, chỉnh riêng cho giao diện Sáng / Tối); khối trích dẫn tô màu theo người được trích.',
          'Giờ gửi nằm cuối dòng chữ cuối khi còn chỗ (tin chữ, chú thích ảnh / file, tin Telegram chỉ có link) — bong bóng gọn hơn.',
          'Ảnh đại diện chữ (2 ký tự viết tắt, màu theo người / nhóm) dùng chung ở danh sách hội thoại, khung chat, thông tin hội thoại, thành viên nhóm, CRM, tìm kiếm, chuyển tiếp, lời mời kết bạn, hồ sơ, tin đánh dấu và ô chọn liên hệ của workflow.',
          'Mở lại app mượt hơn: Telegram chờ danh sách hội thoại hiện xong và app rảnh mới đồng bộ bù, tải lại tin cũ, kiểm tra kênh (chậm nhất 60 giây sau khi mở); tin mới vẫn về và hiện ngay.',
          'Link trong tin ở giao diện Tối đổi sang xanh nhạt, không gạch chân (rê chuột mới gạch) — dễ đọc trên bong bóng xanh; giao diện Sáng giữ nguyên.',
          'Tìm số điện thoại Zalo: ô tìm hội thoại và Tìm kiếm chung dùng chung một lần tìm (không hỏi Zalo 2 lần cho cùng số); kết quả về muộn không hiện lại sau khi đã ẩn hoặc gõ tiếp.',
          'Gõ @ trong nhóm (mọi kênh): danh sách thành viên đọc ngay từ dữ liệu đã lưu, có @username, tìm không dấu theo tên / @username, cuộn hoặc ↓ để xem hết thành viên (trước chỉ hiện 50 người). Telegram: lần đầu lấy thành viên gần đây của nhóm, gõ tên trong nhóm lớn thì tìm thêm trên Telegram — kết quả lưu lại, lần sau không phải tải.',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa Zalo không bao giờ nhận được báo "đã xem" (app nghe sai tên sự kiện của thư viện Zalo) — nay hiện ✓✓ đã xem và dòng "Đã xem" kèm ảnh người xem.',
          'Sửa Facebook bỏ qua báo đã nhận / đã xem từ người nhận (cả tin thường và tin mã hoá đầu cuối).',
          'Sửa tin Telegram tự đổi mã cảm xúc chữ (vd ":))") thành biểu tượng kiểu Zalo — nay giữ nguyên như người gửi gõ.',
          'Sửa gõ @ trong nhóm Telegram lần nào cũng "Đang tải @username..." rất lâu (tải lại từng người, không lưu) và nhóm đông không hiện hết người để nhắc tên.',
        ],
      },
    ],
  },
  {
    version: '26.10.1',
    date: '10/2026',
    type: 'major',
    highlights: [
      '📱 Đồng bộ tin nhắn cũ Zalo từ điện thoại — kéo lịch sử chat trên điện thoại về app theo khoảng thời gian (1 tuần / chọn ngày / toàn bộ), ghép đúng vào hội thoại sẵn có.',
      '💬 Facebook nâng cấp bridge fbchat-v2 2.3.3 — Messenger ổn định hơn; đồng bộ tin nhắn theo khoảng thời gian với nhịp tải như người thật, cuộn lên tải tin cũ, tin mẫu của Page hiện đủ thẻ + nút.',
      '🧩 Ứng dụng tự phát triển — cài và tự viết ứng dụng chạy ngay trong Deplao (trang riêng, panel chat, nút ô soạn tin, node workflow) tại Công cụ → Ứng dụng, API & Webhook; kèm SDK + CLI.',
      '🔌 Public API v1 gần 300 thao tác + tài liệu đầy đủ — API key theo quyền / tài khoản, sự kiện realtime và webhook gửi ra để kết nối phần mềm khác.',
      '☁️ Internet & Đám mây — địa chỉ Internet cố định qua Cloudflare của bạn; lưu media, sao lưu + đồng bộ DB (mã hoá trên máy) lên Cloudflare R2 hoặc Google Drive (Google One); xem mức dùng và phí ước tính; khôi phục sang máy mới hoặc máy dự phòng.',
      '👥 Boss – nhân viên ổn định và an toàn hơn — tự phục hồi kết nối, đồng bộ realtime 2 chiều đầy đủ, nhân viên dùng được Facebook / Telegram qua máy Boss, siết quyền truy cập tài khoản và file.',
      '📣 CRM Chiến dịch làm lại — xem trước nội dung như khung chat, thống kê realtime, tuỳ chọn gửi ảnh trước / chữ trước hoặc gộp ảnh + chữ thành 1 tin.',
      '🎨 Giao diện mới — bảng màu và bộ thành phần thống nhất cho theme Sáng / Tối, thanh điều hướng gọn với nhóm "Công cụ"; bong bóng chat, Cài đặt, CRM, Workflow làm lại.',
      '💬 Chat nhiều nâng cấp — Tin đánh dấu, My Documents, Thao tác nhanh, thả cảm xúc dạng dọc, mốc ngày + nhãn ngày khi cuộn, tự động đánh dấu đã đọc, chuyển tiếp đúng mọi loại tin Zalo.',
      '✈️ Telegram đầy đủ hơn — Nhóm / Kênh mới, Danh bạ, Cuộc gọi, quản lý nhóm / kênh, bảng Sticker · GIF đồng bộ tài khoản, cảm xúc đủ bộ và đồng bộ 2 chiều, video trong link xem ngay.',
      '⚙️ Workflow — sơ đồ + panel mới, bộ lọc trigger mới, sắp xếp tự động, AI copilot dạng chat và chế độ Mô phỏng không gửi tin thật.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Đồng bộ tin nhắn từ điện thoại (Zalo): nút trên thanh trên cùng, chọn tài khoản (cả khi Gộp trang) và khoảng thời gian, chạy nền có tiến độ; hội thoại chỉ có trên điện thoại được tạo kèm tên / ảnh; hiển thị bản tin OA và media đã hết hạn.',
          'Facebook: popup "Đồng bộ tin nhắn Facebook" theo tài khoản + khoảng thời gian, không giới hạn số tin, chạy nền và huỷ được; cuộn lên tải tin cũ qua bridge.',
          'Facebook: tin mẫu của Page hiện thành thẻ (ảnh, tiêu đề, carousel) với nút bấm được — mở link, sao chép số điện thoại, gửi lựa chọn cho Trang.',
          'Ứng dụng (plugin): cài từ file zip hoặc thư mục kèm bước duyệt quyền; chạy dạng web, tiến trình riêng hoặc máy chủ ngoài; gắn được trang riêng, panel trong khung chat, nút ở ô soạn tin, cài đặt, node workflow và lịch chạy. Có SDK `@deplao/plugin-sdk`, lệnh `deplao-plugin`, ứng dụng mẫu và ngăn "Phát triển ứng dụng".',
          'Public API v1 (cổng 9900, mặc định tắt): ~293 thao tác cho tài khoản, chat Zalo / Facebook / Telegram, nhóm, nhãn, danh bạ, CRM, workflow, tích hợp, ERP, AI, báo cáo, media, nhân viên; API key theo quyền / tài khoản / IP / hạn dùng; nhật ký request; trang tài liệu + hướng dẫn tích hợp.',
          'Sự kiện realtime (Socket.IO, SSE, polling) và webhook gửi ra có chữ ký HMAC, tự thử lại; trang Webhook gom "Nhận dữ liệu vào" và "Gửi sự kiện ra ngoài".',
          'Cài đặt → Internet & Đám mây: kết nối tài khoản Cloudflare; một chỗ duy nhất cấu hình địa chỉ Internet (Địa chỉ tạm / Cloudflare tự động / ngrok / Cloudflare thủ công) cho nhân viên ở xa, webhook và thanh toán.',
          'Lưu media lên Cloudflare R2 hoặc Google Drive: tải lên chạy nền, tự lấy lại khi file trên máy thiếu, tuỳ chọn giải phóng ổ máy, phạm vi theo tài khoản và ngày, công cụ dọn file trên kho (quét trước, xác nhận mới xoá).',
          'Sao lưu & đồng bộ DB lên R2 hoặc Google Drive: mã hoá trên máy bằng mật khẩu sao lưu, chế độ Theo giờ / Realtime; khôi phục từng bước sang máy mới, máy dự phòng tự theo dõi bản sao; tự tạm dừng chiến dịch / workflow sau khôi phục để không gửi trùng.',
          'Chọn kho lưu Cloudflare R2 hoặc Google Drive (Google One): đăng nhập Google trên trình duyệt, Deplao chỉ được quyền với file do chính nó tạo (thư mục "Deplao" trong Drive); dùng client Google chung của Deplao hoặc client OAuth riêng; đổi kho khi đồng bộ đang tắt, bản trên kho cũ vẫn giữ.',
          'Mức sử dụng & chi phí: % phần miễn phí và ngưỡng tính phí — R2: dung lượng (GB-tháng), Ghi (Class A), Đọc (Class B), tải xuống; Google Drive: dung lượng tài khoản, đơn vị Drive API, tải lên / tải xuống trong ngày — kèm phí ước tính tháng này + dự kiến cả tháng (USD, quy đổi ₫) và giải thích từng mục; số toàn tài khoản R2 khi token có quyền "Account Analytics: Read".',
          'Chat: Tin đánh dấu cho mọi kênh, Lưu vào My Documents (Zalo, luôn ghim đầu danh sách), Copy hình ảnh, xem bộ sưu tập ảnh từ cũ đến mới.',
          'Thao tác nhanh "+" cạnh ô tìm kiếm hội thoại: tạo nhóm Zalo / Telegram / Messenger, tham gia nhóm bằng link (có xem trước), thêm bạn, thêm lịch hẹn và ghi chú nhanh.',
          'Tự động đánh dấu đã đọc theo khoảng thời gian (menu ⋮ → Tự động), đồng bộ lên Zalo, Telegram, Facebook.',
          'Telegram: Nhóm mới, Kênh mới (công khai / riêng tư), Danh bạ, nhật ký cuộc gọi + báo cuộc gọi đến; màn Quản lý nhóm / kênh (mô tả, link mời, nhóm thảo luận, tự xoá tin…).',
          'Telegram: bảng Sticker · GIF đồng bộ với tài khoản (bộ đã thêm, gần đây, yêu thích, GIF đã lưu), tìm bộ sticker / GIF; bấm sticker trong chat để xem và thêm cả bộ.',
          'Telegram: lưới đầy đủ cảm xúc của Telegram khi chuột phải, dòng "Đã xem" (ai đã xem trong nhóm), thẻ "Chuyển tiếp từ…", trích dẫn hiện tên người gửi.',
          'Telegram: link có video (TikTok…) phát ngay trong thẻ — tự phát không tiếng, bật tiếng tại chỗ; thẻ link hiện tên trang, tiêu đề, mô tả.',
          'Mốc ngày trong khung chat ("Hôm nay", "Hôm qua", "5 ngày trước, 12-10"…) và nhãn ngày nổi khi cuộn.',
          'Workflow: AI copilot dạng chat để thiết kế / sửa kịch bản; chế độ Mô phỏng chạy thử không gửi tin thật; nút "Sắp xếp tự động" cho sơ đồ; bộ lọc trigger mới (vai trò người gửi trong nhóm, loại trừ người gửi / hội thoại, chỉ khi được @nhắc…).',
          'CRM Chiến dịch: tuỳ chọn "Ảnh kèm chữ" — gửi ảnh trước / chữ trước hoặc gộp thành 1 tin (Telegram gửi album có chú thích).',
          'Tin nhắn nhanh và Nhãn Local áp dụng được cho nhiều tài khoản cùng lúc.',
          'Đăng nhập lại Facebook ngay từ Dashboard khi hết phiên (giữ nguyên dữ liệu chat); form đăng nhập có nút hiện mật khẩu, Enter để đăng nhập.',
        ],
      },
      {
        category: 'improved',
        items: [
          'Bridge Facebook lên fbchat-v2 2.3.3 (mautrix-meta 8/2026): hết lỗi socket Messenger kẹt ở bước đồng bộ ban đầu; E2EE dùng thư viện mới; đăng nhập chạy bằng bridge riêng tương thích trang đăng nhập hiện tại của Facebook.',
          'Facebook tải lịch sử theo nhịp người thật (nghỉ ngẫu nhiên, ≤ 10 trang/phút, ≤ 240 trang/giờ), tự dừng 30 phút khi có dấu hiệu checkpoint; popup nhắc rủi ro trước mỗi lượt.',
          'Kết nối nhân viên: trạng thái hiển thị đúng, tự kết nối lại và tự chuyển khi địa chỉ Boss đổi, nhận bù sự kiện bị lỡ; mất kết nối thì giữ dữ liệu đang có thay vì trắng trang.',
          'Nhân viên dùng được thao tác Facebook / Telegram (chạy trên máy Boss); đồng bộ realtime cả sửa, xoá, cảm xúc; quyền ERP của nhân viên kiểm tra trên Boss.',
          'Giao diện: bảng màu mới cho cả Sáng / Tối, thanh điều hướng còn Dashboard · Chat · CRM · Báo cáo · Công cụ · Cài đặt, bong bóng chat có giờ bên trong; Cài đặt, CRM, Workflow, Tích hợp, ERP theo kiểu mới; bộ thành phần giao diện dùng chung (xem ở Cài đặt → Giao diện).',
          'Workflow: thẻ node và panel cài đặt thiết kế lại (gom nhóm trường, kéo rộng panel), ô chọn liên hệ tìm không dấu + phân trang, "Chèn biến" đúng theo trigger; sửa loạt mẫu trong kho mẫu.',
          'CRM Chiến dịch: danh sách gọn, màn chi tiết hiện nội dung gửi theo từng bước như khung chat (thay chuỗi JSON), thống kê realtime, tìm / lọc liên hệ.',
          'Danh sách hội thoại: cuộn và đổi tài khoản mượt hơn, ảnh nhóm chỉ tải cho hàng đang hiện, giữ vị trí cuộn theo từng thư mục, hội thoại ghim luôn ở đầu.',
          'Khung chat mượt hơn: bớt render lại toàn app khi có tin mới / đang gõ, tải tin cũ sớm hơn và giữ đúng vị trí cuộn.',
          'Chuyển tiếp hỗ trợ đúng mọi loại tin Zalo (chữ định dạng, link, danh thiếp, sticker, tin thoại, video, album, ảnh chưa tải về).',
          'Trả lời (trích dẫn) giữ theo từng hội thoại; đang sửa tin mà đổi hội thoại thì huỷ sửa.',
          'Thả cảm xúc dạng thanh dọc dễ chọn, tự mở lên / xuống theo chỗ trống; Zalo / Facebook giữ 6 cảm xúc quen thuộc.',
          'Panel Thành viên nhóm lấy đủ danh sách như CRM (cả thành viên quét ẩn / thu thập từ Telegram), phân trang và tìm không dấu; chỉ gọi API khi mở lần đầu.',
          'Telegram kênh: bài đăng gửi từ app hiện đúng ngay, tin hệ thống thành dòng thông báo, ảnh nhóm / kênh mới hiện ngay.',
          'Báo cáo chia theo ngày lịch — điểm "hôm nay" có số liệu đúng; khoảng 7 / 30 / 90 ngày tính từ 00:00.',
          'Zalo: ảnh JPEG XL hiển thị được (tự đổi sang JPG), media hết hạn báo rõ kèm "Thử tải lại"; nâng thư viện zca-js 2.2.0.',
          'CRM liên hệ Zalo tự làm mới tên / ảnh cũ hoặc lỗi; tích hợp Sapo đăng nhập đúng bằng API Key + Secret của ứng dụng riêng.',
          'Giới thiệu & Hướng dẫn sử dụng viết lại theo bản mới: đủ Zalo, Facebook, Telegram, Telegram Bot; thêm mục Đồng bộ tin nhắn cũ, Ứng dụng, API & Webhook, Internet & Đám mây; hướng dẫn trong trang Báo cáo, bảng Công cụ và tài liệu API (/docs) theo đúng giao diện và đường dẫn hiện tại.',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa bản cài báo "SyntaxError" và không mở được — bước bỏ console khi build làm hỏng main.js; nay dùng parser và chặn đóng gói nếu có lỗi cú pháp.',
          'Sửa reaction Telegram bị lưu thành "1 đống icon", reaction từ Telegram không về app, reaction Zalo bị đếm gấp đôi.',
          'Sửa xoá / thu hồi tin trong chat riêng Telegram làm bài kênh trùng mã bị đánh dấu "đã thu hồi".',
          'Sửa link YouTube trên Telegram tải nhầm cả video và vỡ ảnh xem trước; chú thích ảnh / file Telegram gửi qua workflow / API bị mất.',
          'Sửa đánh dấu đã đọc Telegram vẫn còn dấu @ / ❤ trên app Telegram; đổi ảnh nhóm và cấp quyền quản trị siêu nhóm Telegram luôn lỗi.',
          'Sửa Facebook tải lịch sử ra 0 tin, tin mẫu của Page bị rỗng; đăng nhập lại Facebook không còn xoá tin cũ.',
          'Sửa ảnh JPEG XL của Zalo không hiện kèm vòng lặp tải lại vô hạn; bấm trích dẫn ảnh trong album báo "Không tìm thấy tin nhắn".',
          'Sửa chuyển tiếp album chỉ gửi 1 ảnh, video chuyển tiếp thành file .mp4.',
          'Sửa nhãn Trưởng nhóm / Phó nhóm Zalo bị đảo ở panel thành viên; avatar nhóm mới kẹt chữ cái.',
          'Sửa hội thoại ghim không hiện ở đầu khi nằm ở trang sau của danh sách.',
          'Sửa "Tạo bình chọn" trong khung chat luôn báo lỗi ở mọi kênh.',
          'Sửa workflow Telegram (tài khoản cá nhân) gửi tin rỗng khi nội dung lấy từ node AI.',
        ],
      },
      {
        category: 'security',
        items: [
          'Chặn trang web / iframe trong app đọc file bất kỳ trên máy qua `local-media://`; giới hạn kích thước request relay trước khi xác thực.',
          'Nhân viên chỉ đọc / ghi được tài khoản được giao; không còn đọc được khoá ký token và token tunnel qua API cài đặt.',
          'File trên Boss cần phiên nhân viên hợp lệ; thu hồi token khi khoá / xoá / đổi mật khẩu nhân viên, thêm "Đăng xuất tất cả nhân viên".',
          'Proxy nhân viên chỉ gọi được các thao tác cho phép, không gửi được file ngoài thư mục media; chặn tải URL vào mạng nội bộ (SSRF).',
        ],
      },
      {
        category: 'removed',
        items: [
          'Gỡ "Tải tin nhắn cũ" của Zalo — thay bằng Đồng bộ tin nhắn từ điện thoại.',
          'Cài đặt bỏ tab API và Webhooks (chuyển sang Công cụ → Ứng dụng, API & Webhook); cấu hình địa chỉ / tunnel chuyển về Cài đặt → Internet & Đám mây.',
          'Dashboard bỏ "Cập nhật cookie" Facebook — hết phiên thì đăng nhập lại.',
          'Gỡ màn đăng nhập nhân viên cũ không còn dùng.',
        ],
      },
    ],
  },
  {
    version: '26.10.0',
    date: '10/2026',
    type: 'major',
    highlights: [
      '🚀 Khởi động nhanh và ổn định hơn — tách tiến trình khởi động, chỉ phục hồi kênh sau khi giao diện đã sẵn sàng; sửa màn hình trắng và lỗi crash khi mở app trên Windows.',
      '🧩 Trung tâm "Tất cả tính năng" — một panel tìm kiếm giúp mở nhanh mọi trang và tab con, kèm bật/tắt từng mục hiển thị trên thanh bên.',
      '💬 Facebook cá nhân ổn định hơn — giữ phiên chat riêng tư E2EE qua lần khởi động lại, tự kết nối lại khi mất mạng, đồng bộ lịch sử và hiển thị đúng tên/avatar của từng người.',
      '🤖 AI đa nhà cung cấp — bổ sung GPT-6, Claude 5.5, Fable 5.1 và DeepSeek V4 mới nhất; AI Assistant và Workflow dùng chung một lớp adapter.',
      '✈️ Telegram User và Bot tin cậy hơn — phục hồi channel lưu trữ, poll, mention và trạng thái đồng bộ phản ánh đúng thực tế.',
      '💬 Chat trực quan hơn — bubble Poll Telegram, mention bấm được, tin nhắn thu hồi chứa ảnh/file hiển thị lại đúng nội dung gốc.',
      '⚡ Mở trang và xem báo cáo nhanh hơn — tải trang theo nhu cầu, thêm chỉ mục database, Analytics chỉ nạp dữ liệu của tab đang xem.',
      '🔧 Sửa Zalo reaction không thả được; node thông báo tự lấy nội dung từ node phía trước thay vì gửi tin rỗng.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Trung tâm "Tất cả tính năng" — panel trượt kèm ô tìm kiếm, gom hàng chục điểm đến theo nhóm Truy cập chính, CRM, Workflow, Tích hợp, Báo cáo, Quản lý công việc và Cài đặt; mở thẳng đúng tab/sub-view con.',
          'Bật/tắt hiển thị từng mục trên thanh bên — lựa chọn được lưu cho lần sau; Dashboard và Chat luôn hiển thị cố định.',
          'Nút mở Trung tâm tính năng đặt trên thanh trên cùng.',
          'Tiến trình khởi động tách riêng chặn native addon WebSocket tuỳ chọn — loại bỏ lỗi crash khi mở app trên Windows.',
          'Renderer báo sẵn sàng — Facebook, Telegram, Zalo và migration chỉ bắt đầu chạy sau khi giao diện đã vẽ xong khung hình đầu tiên.',
          'Facebook nhận diện lại tên và avatar liên hệ — tra cứu theo đúng mã người dùng, không còn lấy nhầm hồ sơ đang đăng nhập.',
          'Đồng bộ lịch sử Facebook qua bridge — lấy cả hội thoại chat riêng tư E2EE mà bản đồng bộ web bỏ sót; hội thoại và tin cũ được tự động sửa lỗi người gửi.',
          'Bổ sung loạt thao tác Facebook: bình chọn poll, ghim/bỏ ghim tin, đánh dấu đã xem, đổi giao diện hội thoại, tạo ghi chú, thêm/xoá quản trị viên nhóm, duyệt thành viên chờ và lấy/đặt link mời nhóm.',
          'Zalo lưu mention của nhóm thành dữ liệu riêng — giữ đúng vị trí và người được nhắc.',
          'Bubble Poll Telegram — hiển thị câu hỏi, lựa chọn kèm %, đáp án đã chọn/đáp án đúng và nhãn chọn nhiều, đố vui, đã đóng.',
          'Node thông báo Telegram để trống nội dung sẽ tự lấy văn bản từ node phía trước trong workflow.',
          'Bổ sung model AI: GPT-6 (Luna/Sol/Astra), GPT-4o, Claude Sonnet 5.5, Opus 5.5, Fable 5.1; hỗ trợ tự nhập "Custom model" cho OpenRouter.',
          'Model mặc định cho node AI nâng lên dòng GPT-5.6.',
          'Bổ sung bộ kiểm thử tự động cho bridge E2EE (kết nối, sự kiện tin nhắn, an toàn media, lưu thiết bị) — phát hiện lỗi sớm khi nâng cấp.',
        ],
      },
      {
        category: 'improved',
        items: [
          'Facebook gộp luồng kết nối dashboard và tự khởi động; tự thử lại khi kết nối lúc mở app thất bại (giãn dần theo thời gian) và bỏ bước kiểm tra cookie dư thừa — app mở nhanh, không phải bấm "Kết nối" thủ công.',
          'Facebook giữ nguyên phiên chat riêng tư E2EE qua lần khởi động lại; thời gian kết nối tăng lên 60 giây và xác minh thật trước khi báo thành công.',
          'Facebook tự kết nối lại theo cơ chế thống nhất với thời gian chờ tăng dần; trạng thái E2EE lấy từ socket mã hoá thật thay vì tín hiệu phụ, tránh báo "đã kết nối" giả.',
          'Facebook phân biệt lỗi mạng tạm thời với cookie hết hạn — lỗi kết nối/máy chủ không còn làm ngắt listener vĩnh viễn.',
          'Facebook kiểm tra kết quả thật của mọi thao tác nhóm (đổi tên, emoji, nickname, quyền admin, duyệt thành viên, link mời) — không còn báo thành công giả.',
          'Facebook chặn thao tác nhóm trên hội thoại chat riêng 1:1 với thông báo tiếng Việt rõ ràng thay vì lỗi mơ hồ từ Facebook.',
          'Facebook tự làm mới avatar hội thoại bị sai sau khi tải hộp thư; số chưa đọc lấy đúng từ dữ liệu Facebook và không bị xoá khi tải lại.',
          'Tin nhắn lịch sử Facebook đánh dấu là đã đồng bộ, không phát lại như tin mới — tránh chạy trùng workflow sau khi mở lại app.',
          'Telegram User: channel mới luôn được tạo tác vụ phục hồi, quét hết cả thư mục lưu trữ ("Khác"); kiểm tra kết nối và tự kết nối lại có thời gian chờ rõ ràng.',
          'Telegram User: đối soát thành viên không còn suy nhầm khi danh sách hội thoại bị cắt bớt; nhập lịch sử dài không làm đơ giao diện; thu hồi tin giữ lại đúng loại nội dung và nội dung gốc.',
          'Telegram User: trạng thái đồng bộ phản ánh đúng thực tế (không báo "hoàn tất" khi còn lỗi), hàng đợi phục hồi channel tự giải phóng khi tiến trình treo.',
          'Telegram Bot: hỗ trợ poll đầy đủ (kể cả thêm lựa chọn, cập nhật phiếu), mention theo vị trí và xác minh kết quả gửi/sửa/xoá/ghim/reaction từ Telegram.',
          'AI: gom việc gọi nhà cung cấp vào một adapter chung, tự chuẩn hoá model cũ về model hiện hành và tự cập nhật lại Assistant đã lưu — không cần cấu hình lại thủ công.',
          'AI: điều chỉnh riêng theo từng nhà cung cấp để ổn định (Gemini dùng systemInstruction, Claude 5 bỏ temperature, GPT-6 dùng Responses API, DeepSeek bỏ tham số cũ).',
          'Workflow: node Zalo thả cảm xúc bổ sung trường tin nhắn/hội thoại và hỗ trợ cảm xúc dạng tên (Like, Tim, Haha...) thay cho số.',
          'Workflow: dữ liệu kích hoạt thu thập thêm mã tin nhắn, tên nhóm và tên người gửi — template có sẵn thông tin đầy đủ hơn.',
          'Workflow: tham chiếu dữ liệu node dùng ID ổn định (tránh nhầm khi nhiều node trùng tên); danh sách "dữ liệu node phía trước" thu gọn được.',
          'Analytics: chỉ nạp dữ liệu của tab đang xem; nhãn "Tổng tin nhắn" ghi rõ kỳ thời gian; thống kê thời gian phản hồi và bản đồ nhiệt tính trực tiếp trong database nên mở báo cáo an toàn với kho tin lớn.',
          'Hiệu năng giao diện: các trang lớn tải theo nhu cầu; bỏ tải toàn bộ danh bạ trước khung hình đầu tiên; danh sách hội thoại phân trang.',
          'Database: thêm chỉ mục cho phân trang và báo cáo; các bước làm sạch/migration nặng chỉ chạy một lần thay vì quét toàn bảng mỗi lần mở app.',
          'Database: tổng quan dashboard lọc theo khoảng thời gian và loại hội thoại thay vì đếm toàn bộ dữ liệu.',
          'IPC: giới hạn số tin nhắn trả về mỗi lượt và phân trang danh bạ — tránh làm đơ khi truy vấn khối lượng lớn.',
          'CRM nhóm Telegram: thiết kế lại panel thành viên — tìm kiếm nhóm, làm mới, tìm thành viên, chọn tất cả và nhãn vai trò rõ ràng.',
          'Forum Topics: badge chưa đọc không tự bật lại sau khi đã đọc; làm nổi bật topic đang mở và topic General.',
          'Giao diện Sáng: lưới album và card poll Telegram không còn nền tối trên nền sáng; icon thanh ghim hiển thị đúng màu ở cả hai giao diện.',
          'Hỗ trợ thêm phiên bản bridge E2EE 2.3.2 và bước build nhanh cho môi trường phát triển.',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa màn hình trắng/xanh khi mở app — tiến trình chính chờ giao diện sẵn sàng và có cơ chế khôi phục nếu khung hình đầu tiên không xuất hiện.',
          'Sửa lỗi crash khi mở app trên Windows do native addon WebSocket của thư viện Zalo sau khi nâng cấp Electron.',
          'Sửa tình trạng app "kẹt" E2EE sau khi khởi động lại, trước đây phải bật/tắt thủ công mới chat riêng tư được.',
          'Sửa lỗi avatar Facebook — hội thoại hoặc Page bị gán nhầm avatar của chính tài khoản; tự làm mới avatar nghi vấn sau khi tải hộp thư.',
          'Sửa số chưa đọc Facebook bị tăng gấp đôi mỗi tin đến và tồn sai sau khi đồng bộ.',
          'Sửa nhận diện tin nhắn của chính mình trên Facebook và Telegram — không còn nhầm tin người khác thành đã gửi hoặc bỏ sót thông báo tin đến.',
          'Sửa danh sách hội thoại không hiện lại sau khi khởi động lại (một liên hệ tạm làm bộ đệm bị coi là đầy).',
          'Sửa tin nhắn thu hồi chứa ảnh/file bị mất khung xem trước khi mở lại nội dung gốc.',
          'Sửa Zalo reaction không thả được — gửi đúng tham số thư viện kèm định danh tin nhắn và hội thoại.',
          'Sửa dữ liệu thu hồi của Zalo bị lưu nhầm thành bong bóng tin nhắn thay vì xử lý đúng.',
          'Sửa poll Telegram cập nhật phiếu bầu và trạng thái đóng/mở hiển thị đúng.',
          'Sửa mention của Zalo và Telegram bị mất khi gửi tin; @username cũ bấm vào mở đúng hồ sơ.',
          'Sửa link preview không hiển thị ở một số workflow do sai tên hành động.',
          'Sửa `$trigger.groupName` chưa có ngay trong lần chạy workflow với tin nhắn nhóm Zalo.',
          'Sửa tham chiếu node dễ nhầm khi nhiều node dùng cùng nhãn.',
          'Sửa build bridge dùng cache/safe-directory sai khiến khi chạy dev vẫn dùng binary E2EE cũ.',
        ],
      },
      {
        category: 'removed',
        items: [
          'Gỡ các màn hình quản lý Telegram Bot riêng (project, lệnh, rule, lịch chạy, báo cáo) — toàn bộ năng lực đã chuyển sang node Workflow.',
          'Gỡ các tệp và nhánh code trùng lặp của hệ thống Telegram Bot cũ.',
          'Gỡ biểu đồ "Thời gian phản hồi theo giờ" khỏi tab Tổng quan của Báo cáo (đã có ở tab Tin nhắn).',
        ],
      },
    ],
  },
  {
    version: '26.9.0',
    date: '09/2026',
    type: 'major',
    highlights: [
      '💬 Facebook cá nhân nâng cấp thư viện fbchat-v2 lên bản mới nhất — thay đổi đăng nhập tài khoản có 2FA, chat riêng tư E2EE và trạng thái thiết bị ổn định hơn sau khi mở lại ứng dụng.',
      '✈️ Đồng bộ Telegram User đáng tin cậy hơn — phục hồi tin nhắn của channel, supergroup và topic sau khi mất mạng; tiến trình tiếp tục được sau khi khởi động lại app.',
      '🤖 Workflow Telegram Bot hoàn thiện — thêm đầy đủ trigger, hành động quản trị nhóm, gửi media, reaction, poll và Reply Keyboard hoặc Inline Button trực quan.',
      '🔄 Workflow Chuyển tiếp tin nhắn đa kênh — chọn rõ tài khoản gửi và đích, gửi linh hoạt giữa Zalo, Facebook, Telegram User và Telegram Bot, kể cả ảnh và file.',
      '🗂️ Thư viện ảnh và file dùng chung giữa các trang — lọc theo một trang hoặc tất cả trang, nhớ phạm vi đã chọn và gửi đúng kênh đang sử dụng.',
      '💻 Giao diện tự phục hồi sau khi gập/mở laptop — đồng bộ nền tiếp tục chạy và renderer sẽ kết nối lại an toàn nếu Windows tạm dừng kết nối cục bộ.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Đăng nhập Facebook cá nhân bằng Messenger Lite — hỗ trợ email hoặc số điện thoại, mật khẩu, mã 2FA TOTP hoặc SMS, captcha và xác nhận thiết bị theo từng bước.',
          'Lưu trạng thái thiết bị Facebook E2EE an toàn — phiên chat riêng tư không phải khởi tạo lại hoàn toàn khi đóng và mở ứng dụng.',
          'Đăng nhập Facebook kiểm tra tương thích bridge trước khi sử dụng — phát hiện sớm phiên bản hoặc khả năng bridge không phù hợp, thay vì lỗi mơ hồ khi chat.',
          'Gửi file Facebook theo một luồng thống nhất — kiểm tra file tồn tại, kích thước tối đa 25 MB và định dạng được hỗ trợ trước khi gửi.',
          'Các thao tác Facebook trong chat riêng tư E2EE — thu hồi, sửa tin, đang nhập và xác nhận đã đọc được gửi lên Messenger thực tế.',
          'Điều chỉnh chiều rộng danh sách hội thoại — kéo divider giữa sidebar và khung chat, phạm vi 240–480 px và tự lưu cho lần sau.',
          'Bộ chọn phạm vi thư viện — chọn một tài khoản cụ thể hoặc Tất cả trang; hiển thị avatar, tên và kênh của từng tài khoản.',
          'Thư viện media gửi đa kênh — ảnh/file đã lưu có thể gửi sang Facebook, Telegram User, Telegram Bot hoặc Zalo theo đúng hội thoại đích.',
          'Telegram Bot có thêm 6 trigger workflow: nhận tin nhắn, nhận lệnh, nhấn Inline Button, bot vào/rời nhóm, tin nhắn bị sửa và yêu cầu vào nhóm.',
          'Telegram Bot có bộ lọc trigger — giới hạn theo chat, nội dung, từ khóa, alias lệnh, tham số và danh sách người được phép.',
          'Telegram Bot gửi tin nhắn với Reply Keyboard hoặc Inline Button — hỗ trợ nhiều hàng nút, callback và nối callback đến node tiếp theo trong cùng workflow.',
          'Telegram Bot có thêm hành động gửi ảnh/video/file, chuyển tiếp, sửa/xóa/ghim tin, reaction, poll, typing, cấm và hạn chế thành viên.',
          'Workflow chọn tài khoản rõ ràng theo từng node — hành động chỉ hiện các tài khoản phù hợp với kênh đang chọn.',
          'Chuyển tiếp workflow đa kênh — gửi văn bản, ảnh và file giữa Zalo, Facebook, Telegram User và Telegram Bot.',
          'Telegram User có queue phục hồi channel lưu trong database — không mất tiến trình nếu ứng dụng bị tắt hoặc khởi động lại giữa lúc đồng bộ.',
          'Telegram User tự sửa access hash thiếu khi có thể, quét thêm hội thoại Archived và phát tiến trình đồng bộ cho giao diện.',
          'Quét thành viên nhóm Zalo dùng hook mới, không còn yêu cầu kiểm tra premium.',
          'Zalo kiểm tra file ảnh trước khi gửi; GIF được gửi theo luồng đính kèm riêng để tương thích thư viện Zalo.',
        ],
      },
      {
        category: 'improved',
        items: [
          'Facebook tự xác định loại hội thoại từ dữ liệu đã lưu thay vì đoán theo ID số; chat riêng đi E2EE, group đi REST và hội thoại chưa xác định báo lỗi rõ ràng.',
          'Facebook bỏ toàn bộ fallback E2EE sang REST — không còn nguy cơ một tin nhắn riêng tư bị gửi trùng khi bridge timeout hoặc trả lỗi.',
          'Facebook serialize các request bridge, loại bỏ event/response từ process cũ và giới hạn queue/buffer để bridge ổn định khi gửi đồng thời nhiều thao tác.',
          'Facebook phân biệt lỗi mạng tạm thời với cookie hết hạn — lỗi DNS hoặc kết nối không còn làm ngừng reconnect MQTT nhầm.',
          'Facebook giảm log nhạy cảm và log quá dài; bổ sung số liệu nội bộ cho restart bridge, event cũ, lỗi gửi và lỗi lưu state.',
          'Telegram User backfill phân trang, giới hạn nhịp request và tăng số lát channel difference để theo kịp channel/supergroup lớn mà ít FLOOD_WAIT hơn.',
          'Telegram User xử lý FLOOD_WAIT bằng thời điểm retry lưu trong database thay vì đánh fail; lỗi typing/reaction không còn làm hỏng toàn bộ vòng GetDifference.',
          'Telegram User tải media sau khi đã phát event tin nhắn — sticker/ảnh mới có thể hiện ngay, không cần chọn lại hội thoại.',
          'Telegram User cập nhật preview, thời gian last message và avatar channel ngay khi đồng bộ; lỗi CHANNEL_PRIVATE có thông báo dễ hiểu.',
          'Tên người trong Telegram service message lấy từ peer đã đồng bộ, hiển thị đúng người tham gia/rời nhóm thay vì tên rỗng hoặc ghép sai.',
          'Telegram Bot kiểm tra kết quả thực tế của mọi action API: gửi, chuyển tiếp, sửa, xóa, ghim, reaction, poll và typing không còn báo thành công giả.',
          'Telegram Bot phát hiện lỗi 409 khi token bị process khác polling; dừng vòng retry vô tận và báo tài khoản bot cần xử lý.',
          'Node Telegram Bot được gộp vào nhóm Hành động và Kích hoạt chung với các kênh khác; danh sách chỉ hiện action phù hợp với kênh Bot.',
          'Thư viện tải folder và media theo nhiều chủ sở hữu, lưu lại phạm vi người dùng chọn; panel topic forum tận dụng toàn bộ chiều rộng danh sách hội thoại.',
          'Bảo mật state E2EE bắt buộc dùng safeStorage; cơ sở dữ liệu log câu SQL và số lượng tham số khi lỗi nhưng không ghi giá trị nhạy cảm.',
          'Migration dữ liệu giữ cả bản ghi nguồn/đích khi có hội thoại trùng; giảm spam log upsert thành viên lúc Telegram catch-up.',
          'Avatar nhóm composite ưu tiên người có ảnh và fallback về chữ cái khi ảnh lỗi; @mention trong caption video và sticker realtime được render chính xác hơn.',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa tạo mã 2FA Facebook TOTP với otplib mới và kiểm tra định dạng Base32 trước khi đăng nhập.',
          'Sửa Facebook bridge cũ phát event đóng hoặc response muộn làm reconnect nhầm; response E2EE thiếu message ID giờ trả lỗi thay vì gửi lặp qua REST.',
          'Sửa xác nhận đã đọc Facebook dùng watermark thời gian tin mới nhất thực tế; IPC trả đúng kết quả thất bại thay vì luôn thành công.',
          'Sửa chuyển tiếp Facebook xác định loại hội thoại đích, không còn dùng loại group của tin nguồn để quyết định cách gửi.',
          'Sửa reaction Facebook chỉ ghi local sau khi Messenger nhận thành công.',
          'Sửa parse phản hồi GraphQL Facebook gồm anti-JSON prefix và các dạng lỗi khác nhau, tránh coi mutation thất bại là thành công.',
          'Sửa login/lưu file Facebook: từ chối file thiếu, rỗng, là thư mục, vượt 25 MB hoặc sai định dạng ngay từ đầu.',
          'Sửa hiển thị và đồng bộ Telegram: avatar channel mới tự tải, danh sách hội thoại có last message đúng sau tải tay, queue recovery không mất sau restart.',
          'Sửa Telegram service message để hiển thị tên thành viên tham gia qua link mời; callback join request có schema config đầy đủ.',
          'Sửa Telegram Bot polling conflict và tất cả action Bot kiểm tra `ok` từ Telegram trước khi phản hồi kết quả vào workflow.',
          'Sửa Zalo gửi ảnh: kiểm tra file, định dạng và kích thước ảnh trước khi tạo payload; GIF không còn gửi nhầm endpoint ảnh.',
          'Sửa chọn media Facebook từ thư viện bằng cả Facebook ID của tài khoản; event sticker không còn áp local path nhầm giữa các account.',
          'Sửa màn hình trống sau khi Windows resume ở môi trường phát triển: khi Vite localhost báo `ERR_NETWORK_IO_SUSPENDED`, Electron chờ network hồi phục rồi tải lại renderer có giới hạn thay vì lặp vô hạn.',
        ],
      },
      {
        category: 'removed',
        items: [
          'Bỏ toàn bộ premium gating, cache, badge, thông báo và luồng thanh toán cũ của tính năng quét thành viên nhóm Zalo.',
          'Bỏ các component giới thiệu affiliate và thanh toán QR không còn dùng.',
          'Bỏ retry E2EE sang REST và fallback group qua bridge của Facebook để ngăn gửi tin nhắn trùng.',
          'Bỏ section Telegram riêng trong workflow; node Telegram Bot nằm trong nhóm Kích hoạt và Hành động chung.',
        ],
      },
    ],
  },
  {
    version: '26.8.5',
    date: '08/2026',
    type: 'minor',
    highlights: [
      '👥 Telegram CRM nâng cấp chiến dịch gửi tin hàng loạt — Chi tiết liên hệ chỉnh sửa, thành viên nhóm, quản lý chiến dịch',
      '📨 Chuyển tiếp tin nhắn — Đa tài khoản, đa nền tảng (Zalo ↔ Telegram ↔ Facebook)',
      '🏷️ Zalo gợi ý danh thiếp — Tự động gợi ý khi gõ SĐT, copy SĐT',
      '💬 @mention chính xác hơn — Bắt @mention trong tin nhắn ảnh kèm text và bỏ false trigger sai dạng @@',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Chuyển tiếp đa tài khoản — Dropdown chọn tài khoản gửi, avatar + ChannelBadge đồng bộ sidebar',
          'Chuyển tiếp đa nền tảng — Zalo→Telegram, Telegram→Zalo, Facebook→Zalo, v.v.',
          'Phân trang chuyển tiếp — Load 50/trang từ DB, infinite scroll + "Xem thêm"',
          'Tìm kiếm DB chuyển tiếp — Debounce 300ms, query tên/SĐT/ID qua getContactsFiltered',
          'Target selector "Theo thành viên nhóm" — Chọn nhóm, xem số thành viên, import khi xác nhận',
          'Copy SĐT từ gợi ý danh thiếp — Icon copy bên cạnh SĐT trong suggestion bar',
          'CRM Contact Detail — Chỉnh sửa chi tiết liên hệ (SĐT, giới tính, sinh nhật), hiển thị channel',
          'Group Members Tab — Avatar dùng toLocalMediaUrl, cải thiện UI thành viên nhóm',
          'Telegram Bot Commands — Menu lệnh khi chat với bot, Mini App WebView',
          'Telegram Media Preview Workflow — Normalize media previews cho workflow engine',
          'Workflow Contact Picker — Nút xóa liên hệ trong chế độ đơn',
        ],
      },
      {
        category: 'improved',
        items: [
          'Phone regex SĐT — Fix từ 11 xuống 10 chữ số (0 + 9 digits)',
          'getUserInfo response — Đọc changed_profiles[uid] thay vì response trực tiếp',
          'linkifyText @mention — Highlight xanh, regex require ≥1 chữ/số sau @',
          'Phân trang Nhóm chung — API page/limit thay vì load all',
          'Lọc danh mục Nhóm chung — API categoryId thay vì client-side',
          'sendOneForward — Đơn giản hóa, gửi đúng loại tin nhắn, không await phức tạp',
          'Forward auth — Lấy auth + channel từ target account',
          'TelegramUserListener — Nâng cấp lớn (469 lines), cải thiện message handling',
          'ChatWindowBubbles — Cải thiện render media',
          'TopBar — Cải thiện UI',
          'AI assistant error logging — Chi tiết hơn khi LLM call thất bại',
          'Database service — Thêm query methods mới',
          'Adapters — Cải thiện Facebook, Telegram Bot, Telegram User adapters',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa @mention false trigger — indexOf-based detection, loại bỏ @, @@, @@@',
          'Sửa regex phone — /0\\d{10}/ → /0\\d{9}/ (10 chữ số)',
          'Sửa getUserInfo — changed_profiles[uid] thay vì response.displayName',
          'Sửa Nhóm chung load — DB thay vì props',
          'Sửa phân trang Nhóm chung — API total thay vì client length',
          'Sửa linkifyText — /@\\w+/ match @@ → require ≥1 char',
          'Sửa chuyển tiếp text/images — fire-and-forget, không await block',
          'Sửa mention selection — Giữ caret, thay @query khi chọn, reopen suggestions',
          'Sửa workflow contact picker — Nút xóa trong chế độ đơn',
          'Sửa Telegram media preview — Normalize cho workflow engine',
          'Sửa Title bar hiển thị sai trên macOS',
          'Sửa nếu số điện thoại cuối danh sách bị "failed", chiến dịch sẽ không thông báo hoàn thành.'
        ],
      },
    ],
  },
  {
    version: '26.8.4',
    date: '08/2026',
    type: 'minor',
    highlights: [
      '🎬 Video Player inline — Xem video ngay trong app, hỗ trợ seek/scrub, auto-fix MP4 faststart',
      '🤖 Telegram Bot Commands — Menu lệnh bot, Mini App WebView, inline buttons trên tin nhắn',
      '💰 CRM nâng cấp — Quét nhóm premium hỗ trợ Affiliate',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'VideoPlayer modal — Xem video inline (giống Telegram), hỗ trợ play/pause, volume, progress bar, fullscreen, keyboard shortcuts (Space, Esc, F, Arrow keys)',
          'Auto-fix MP4 không faststart — Tự động detect và chạy ffmpeg movflags +faststart cho video Telegram',
          'Bot commands menu — Khi chat với Telegram bot, gõ / hiện menu lệnh, Enter để chọn, filter theo từ khóa',
          'Telegram Mini App (WebView) — Mở Mini App trong modal iframe, auto prolong session mỗi 55s',
          'Inline buttons trên tin nhắn — Parse và render ReplyInlineMarkup từ Telegram (url, webview, callback)',
          'Bot detection (is_cov_bot) — Tự động nhận diện bot khi sync dialog hoặc nhận message mới',
          'Refresh avatar contact — Thêm IPC refreshContactAvatar để tải lại avatar khi file bị mất',
          'DB migration: contacts.is_cov_bot, menu_button, has_main_app + messages.inline_buttons',
        ],
      },
      {
        category: 'improved',
        items: [
          'Bot menu button — Hiển thị nút Menu/Open/tên custom trước ô nhập tin nhắn dựa trên menu_button của bot',
          'Open button cho bot có Main App — Hiển thị nút "Open" trên conversation list',
          'Telegram username search chặt hơn — Bắt buộc phải bắt đầu bằng @ mới nhận diện là username',
          'Avatar profile từ getUserProfile — Ưu tiên avatarUrl trước khi fallback avatar',
          'Skip service messages từ channel chưa join — Filter service messages nếu membership state != member',
          'Fallback DB membership check — Query DB để kiểm tra membership state khi không có chat object',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi GROUP_PRIVATE error spam — Không log warning khi getChannelDifference gặp lỗi CHANNEL_PRIVATE',
          'Sửa lỗi reset is_cov_bot/has_main_app — Auto-reset giá trị cũ (0) về NULL để contacts được re-check',
          'Sửa lỗi vô hiệu hóa LinkIcon import không cần thiết trong GlobalSearchPanel',
        ],
      },
    ],
  },
  {
    version: '26.8.3',
    date: '08/2026',
    type: 'minor',
    highlights: [
      '📊 CRM nâng cấp — Xuất danh sách thành viên CSV, quản lý liên hệ chiến dịch, ưu tiên tìm kiếm theo từ khóa',
      '🔍 Tìm kiếm tin nhắn nhanh — Gõ /1 ưu tiên mẫu có từ khóa /1 trước nội dung',
      '⚡ Premium sync — Tự động dùng API quét nhóm khi tài khoản có Premium',
      '👥 Thành viên nhóm — Luôn gọi getUserInfo lấy tên cho thành viên chưa có tên',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Nút "Xuất danh sách" thành viên nhóm — Export CSV với STT, Tên, UID, SĐT, Vai trò',
          'Nút "Xuất danh sách" liên hệ chiến dịch — Export CSV với STT, Tên, UID, SĐT, Trạng thái, Thời gian gửi',
          'Nút xóa liên hệ khỏi chiến dịch — Xóa từng liên hệ hoặc xóa tất cả (chỉ khi draft/tạm dừng)',
          'Quét thành viên nhóm Zalo dùng API scan chung, không còn kiểm tra Premium hoặc ngày hết hạn',
          'Event crm-contacts-changed — Tự động làm mới danh sách liên hệ sau khi thêm từ nhóm',
        ],
      },
      {
        category: 'improved',
        items: [
          'Tìm kiếm tin nhắn nhanh — Ưu tiên sắp xếp theo keyword trước nội dung (gõ /1 hiện /1 trước)',
          'Xuất CSV — Dùng format ="..." cho UID và SĐT dài để Excel không chuyển sang scientific notation',
          'Thông báo sau khi xuất CSV — Hiển thị toast thành công với số lượng liên hệ đã xuất',
          'Bottom action bar nhóm — Luôn hiển thị 2 nút "Thêm vào chiến dịch" / "Thêm vào liên hệ", disable khi chưa chọn',
          'getUserInfo fallback — Luôn gọi cho thành viên chưa có tên, bỏ ngưỡng 50%',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi file media tên kết thúc bằng dấu chấm — Windows không cho xóa/update file "filename."',
          'Sửa lỗi gắn nhãn Zalo hàng loạt — Chia batch 50 liên hệ mỗi lần để tránh API limit',
          'Sửa lỗi danh sách liên hệ chiến dịch không hiển thị ngay sau khi thêm SĐT',
          'Sửa lỗi danh sách CRM không refresh sau khi thêm liên hệ từ nhóm',
          'Sửa lỗi useRef temporal dead zone trong CRMPage',
        ],
      },
    ],
  },
  {
    version: '26.8.2',
    date: '08/2026',
    type: 'minor',
    highlights: [
      '💬 Telegram reply/quote — Trả lời tin nhắn kèm trích dẫn nội dung gốc, @mention clickable mở profile',
      '⚡ Chat ổn định hơn — Tải tin nhắn cũ bằng IntersectionObserver, phát hiện @mention chính xác, xóa cờ đã đọc tự động',
      '💳 Thanh toán QR — Gia hạn tính năng quét nhóm ẩn tự động',
      '🌐 Xây dựng kho Nhóm chung từ cộng đồng — Ai cũng có thể chia sẻ nhóm Zalo cho mọi thành viên sử dụng',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Tự động xác nhận thanh toán và cập nhật hạn Premium',
          'Chia sẻ nhóm — Popup nhập link, validate bằng getGroupLinkInfo, chọn danh mục, ghi chú. 18 ngành nghề',
          'Danh sách nhóm chung — Layout 2 bên (danh mục + nhóm), search bỏ dấu, phân trang, copy link',
          'Telegram reply/quote — gửi tin nhắn trả lời kèm trích dẫn nội dung gốc, lưu quote_data vào DB',
          'Telegram @mention clickable — nhấn @username mở profile Telegram trong trình duyệt',
          'Workflow zalo.getMessageHistory đọc từ DB cục bộ thay vì gọi API Zalo — tránh lỗi 404/rate limit',
        ],
      },
      {
        category: 'improved',
        items: [
          'backendService.ts — Thêm API payment + shared groups, map response snake_case → camelCase, header x-api-key',
          'GroupMembersTab — Premium section với nút "Mua ngay" / "Gia hạn thêm" mở popup',
          'ShareGroupModal — Auto-validate link khi mở, scrollable trên màn hình nhỏ',
          'Chat — Dùng IntersectionObserver thay scroll event để tải tin nhắn cũ, ổn định hơn',
          'Chat — Fallback retry cho hội thoại <20 tin không load được trang cũ',
          'Phát hiện @mention chính xác hơn — dùng regex thay vì includes(), phân biệt @all/@allStar, dùng username cho Telegram',
          'Xóa cờ @mention khi mở hội thoại — tự động unset has_mention flag',
          'Avatar badge trong chế độ gộp trang to hơn, dễ nhìn hơn',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi Buffer is not defined + createCipheriv not available trong encryptBody',
          'Sửa lỗi Telegram false "đã chỉnh sửa" — cập nhật reaction không còn set nhầm is_edited=1',
        ],
      },
    ],
  },
  {
    version: '26.8.1',
    date: '08/2026',
    type: 'patch',
    highlights: [
      '🔧 Fix bug Telegram — edit message, reply quote, read sync, auto-read, self-sent message, unread count',
      '⚡ Workflow Telegram mở rộng — 3 trigger mới + 14 action mới, contact-picker cho tất cả fields',
      '📌 Forum topic — đánh dấu đã đọc đúng topic (messages.ReadDiscussion), UI topic panel giống Telegram',
      '🔐 Fix Zalo connect_failed — sửa 3 lỗi liên quan cookies encryption gây mất kết nối tài khoản sau khi update',
    ],
    changes: [
      {
        category: 'fixed',
        items: [
          'Sửa lỗi Zalo connect_failed "Cookies tài khoản không hợp lệ" — decryptCookies có fast-path sai: base64 20+ chars không bắt đầu bằng U2Fsd bị skip, nhưng trên Windows DPAPI encrypt produces prefix khác. Giờ luôn gọi safeStorage.decryptString cho mọi base64 string',
          'Sửa lỗi startupAllWorkspaces đọc Telegram accounts như Zalo — query SELECT thiếu filter channel, truyền Telegram session/bot token vào loginZalo gây JSON.parse fail. Giờ filter channel=zalo',
          'Sửa lỗi ZaloService tạo connection mới thay vì reuse — authKey mismatch giữa plain cookies (QR login) và encrypted cookies (DB). ZaloService.initialize() giờ check connection hiện có theo zaloId trước khi tạo mới',
          'Sửa lỗi Telegram edit message — field message/id đảo ngược trong editMessageParams gây lỗi API',
          'Sửa lỗi reply quote không gửi kèm khi reply tin nhắn Telegram — TelegramUserAdapter bỏ qua param quote, giờ extract replyToMsgId từ JSON và truyền qua IPC',
          'Sửa lỗi tin nhắn đọc trên Telegram không đồng bộ về app — UpdateReadHistoryOutbox thiếu event:seen emit nên renderer không nhận được read receipt',
          'Sửa lỗi tự động đánh dấu đã đọc Telegram — ConversationList effect [activeAccountId] gọi handleSelect tự động khi chuyển tài khoản, gửi read receipt mà user chưa click',
          'Sửa lỗi unread_count bị đảo ngược trong DB — SQL CASE WHEN ? = 0 increment cho tin nhắn từ mình thay vì từ người khác',
          'Sửa lỗi tin nhắn self-sent không hiển thị last message — socket echo bị skip do INSERT OR IGNORE nhưng emit trực tiếp không đến renderer, giờ dùng socket handler flow đầy đủ',
          'Sửa lỗi edit history và recalled content mất khi chuyển hội thoại — edit handler chỉ update content mà không set is_edited=1/edit_history, delete handler chỉ set msg_type=deleted mà không set is_recalled=1/recalled_content',
          'Sửa lỗi Forum topic panel — unread badge không xóa khi click topic, bỏ icon circle màu cũ, redesign layout giống Telegram (title + time + badge trên 1 dòng)',
          'Sửa lỗi forum topic read receipt — dùng messages.ReadDiscussion thay vì channels.ReadHistory (GramJS schema chưa hỗ trợ top_msg_id)',
          'Sửa lỗi conversation list restore effect tự gửi read receipt — tách UI restore khỏi handleSelect, chỉ khôi phục state mà không gọi markAsRead',
          'Sửa lỗi voice message Telegram — Bot listener gán msgType=thay vì voice, isVoiceType() thiếu check msgType=voice, VoiceBubble không load được từ attachments',
          'Sửa lỗi caption trùng khi gửi file Telegram — InputMedia có caption + SendMedia cũng có message, giờ chỉ giữ message trong SendMedia',
          'Sửa lỗi mimeType sai khi gửi file MTProto — hardcode video/mp4 và application/octet-stream, giờ dùng ALL_MIME map đầy đủ',
          'Sửa lỗi Bot API send methods không lưu DB — sendVideo/sendDocument/sendAudio/sendVoice/sendAnimation/sendVideoNote/sendSticker giờ lưu message + emit event',
          'Sửa lỗi .flac không nhận diện được — thêm vào AUDIO_EXTS, ALL_MIME, adapter extension checks',
          'Sửa lỗi messageId > 2^31 gây crash — dùng client.sendFile() thay invoke(SendMedia), tự parse Message.id đúng 32-bit',
          'Sửa lỗi gửi file/video từ library không hiện trong UI — emit từ sendFile + trigger background download trực tiếp',
          'Sửa lỗi .webp bị detect thành sticker — fileType từ UI ưu tiên hơn media attributes khi detect msgType',
          'Sửa lỗi avatar URL scheme media://local/ không load — normalize trong chatStore.setContacts()',
          'Sửa lỗi socket echo không update msg_type — persistTelegramMessage luôn update msg_type từ echo, return updated khi merge attachments',
          'Sửa lỗi addMessage không merge attachments — socket echo arrives nhưng UI store không update vì duplicate check skip',
          'Sửa lỗi local-media:// không tìm thấy file thiếu extension — protocol handler tự thử .jpg/.png/.webp/.mp4/.ogg/.mp3',
          'Sửa lỗi MessageMediaWebPage video lưu sai extension — getMediaExtension detect media type thật từ webpage content',
          'Sửa lỗi MessageQueue không deduplicate temp message — adapter trả messageId nhưng queue check msgId, giờ trả cả hai',
          'Sửa lỗi gửi file từ máy tính qua library cho Telegram — handleDirectFile luôn dùng ipc.zalo, giờ detect channel và dùng channelIpc',
          'Sửa lỗi video caption không hiển thị — renderVideo trong ChatWindow dùng FBVideoThumb không có caption, giờ render caption dưới video',
          'Sửa lỗi @username không parse trong tin nhắn — linkifyText chỉ handle URLs, giờ thêm @username parsing',
        ],
      },
      {
        category: 'new',
        items: [
          'Workflow trigger: tg.trigger.unsend — kích hoạt khi tin nhắn bị thu hồi trên Telegram',
          'Workflow trigger: tg.trigger.groupEvent — kích hoạt khi thành viên vào/rời nhóm Telegram',
          'Workflow trigger: tg.trigger.message nâng cấp — thêm chatType filter (all/user/group/channel/topic), contact picker cho chatId và fromId, keyword mode đầy đủ',
          'Workflow action: tg.markAsRead — đánh dấu đã đọc hội thoại Telegram',
          'Workflow action: tg.markTopicAsRead — đánh dấu forum topic đã đọc (messages.ReadDiscussion)',
          'Workflow action: tg.sendSticker — gửi sticker từ sticker set',
          'Workflow action: tg.sendTyping — hiển thị trạng thái đang gõ',
          'Workflow action: tg.addMember / tg.removeMember — thêm/xóa thành viên nhóm',
          'Workflow action: tg.blockUser / tg.unblockUser — chặn/bỏ chặn người dùng',
          'Workflow action: tg.changeGroupName — đổi tên nhóm Telegram',
          'Workflow action: tg.leaveGroup — rời khỏi nhóm Telegram',
          'Workflow action: tg.exportInviteLink — lấy link mời tham gia nhóm',
          'Workflow action: tg.createForumTopic — tạo topic mới trong nhóm Telegram Forum',
          'Contact picker cho workflow — tất cả input chọn hội thoại/nhóm/người dùng dùng popup contact-picker, tự lọc theo kênh Telegram (channel: telegram_user)',
          'Bulk assign local label — transaction-based bulk insert thay vì hàng nghìn IPC calls riêng lẻ, nhanh hơn ~100x',
        ],
      },
    ],
  },
  {
    version: '26.8.0',
    date: '08/2026',
    type: 'major',
    highlights: [
      '🤖 Tích hợp Telegram Bot + Telegram User (beta) — gửi/nhận tin nhắn, ảnh, video, file, quản lý nhóm',
      '🌐 Workflow hỗ trợ Telegram Bot + Telegram User — trigger workflow từ tin nhắn, gửi tin nhắn tự động qua node',
      '🔗 Link trong tin nhắn hiển thị xanh + gạch chân, click mở trình duyệt bên ngoài',
      '📜 Sửa lỗi chập chờn scroll nhảy khi tải tin nhắn cũ',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Tích hợp Telegram Bot (beta) — kết nối qua bot token, polling tin nhắn mới, gửi text/ảnh/video/file/audio/sticker/voice/GIF, quản lý nhóm (admin, kick, pin, đổi tên, đổi avatar)',
          'Tích hợp Telegram User (beta) — kết nối qua MTProto, đồng bộ tin nhắn real-time, hỗ trợ forum/topics, gửi reaction, edit, forward, unsend',
          'Workflow hỗ trợ Telegram Bot + Telegram User — trigger workflow từ tin nhắn, gửi tin nhắn tự động qua node',
          'Link clickable trong tin nhắn — detect URL (http/https/www/domain), hiển thị xanh gạch chân, click mở trình duyệt bên ngoài (shell.openExternal)',
          'Username cho tài khoản Telegram — hiển thị @username thay vì SĐT (Telegram không có SĐT), lưu riêng field username trong account',
          'Avatar fallback theo kênh — Sidebar hiện icon Zalo/Facebook/Telegram khi không có avatar, giống Dashboard',
          'Telegram Bot health check + auto-reconnect — check bot có đang polling không mỗi 60s, nếu disconnect thì startBot lại',
        ],
      },
      {
        category: 'improved',
        items: [
          'Gửi ảnh/file/video cho Telegram Bot — dùng fs.createReadStream cho local file (trước đây chỉ hỗ trợ URL)',
          'TelegramBotAdapter.sendAttachment routing đúng theo file type — image→sendPhoto, video→sendVideo, audio→sendAudio, file→sendDocument',
          'Sửa lỗi "An object could not be cloned" khi gọi getActiveBots — strip non-serializable properties (functions, circular refs) trước khi trả qua IPC',
          'Contact mới từ Telegram hiện ngay trong danh sách — trước đây chỉ lưu DB, không cập nhật Zustand store',
          'Avatar Telegram Bot/User được fetch và cập nhật vào UI — emit db:unreadChanged sau khi download avatar để trigger refresh',
          'Telegram User fetchNewContactAvatar emit đúng source — trước đây emit không có source bị filter bỏ',
          'reconnectAllTelegramAccounts dùng đúng field — botUsername từ acc.username, botFirstName từ acc.full_name',
          'Tải tin nhắn cũ không nhảy vị trí scroll — dùng useLayoutEffect thay vì useEffect + requestAnimationFrame, restore scrollTop đồng bộ trước khi paint',
          'Hiển thị "Không có hội thoại" ngay khi load xong mà không có data — trước đây skeleton hiện 8s mới chuyển',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi Telegram Bot/User tự đánh dấu đã đọc dù chưa đọc — thêm channelIpc.markAsRead() cho non-Zalo channels trong auto-read flow (incoming message + window focus)',
          'Sửa lỗi link trong tin nhắn mở trong app thay vì trình duyệt — thêm e.preventDefault() trước shell.openExternal',
          'Sửa lỗi gửi ảnh từ clipboard/thư viện không hoạt động cho Telegram Bot — isNonZalo fallback nhầm vào Facebook IPC, đổi thành isTelegram check trước',
          'Sửa lỗi Telegram Bot không tự kết nối khi mở app — reconnectAllTelegramAccounts dùng sai field (acc.full_name thay vì acc.username cho botUsername)',
          'Sửa lỗi avatar Sidebar hiện ảnh rỗng khi URL lỗi — onError ẩn img + retry fail → xóa avatar_url để fallback sang channel icon',
          'Sửa lỗi ConversationList skeleton 8s khi không có contact — setInitialLoading(false) ngay khi load trả về 0 item',
          'Sửa lỗi "An object could not be cloned" khi gọi telegram:getActiveBots — account object chứa _inboxConsumer (function) không serialize được qua IPC',
          'Sửa lỗi scroll nhảy khi tải tin nhắn cũ — requestAnimationFrame chạy sau paint, bị race condition với browser layout; đổi sang useLayoutEffect chạy trước paint',
        ],
      },
    ],
  },
  {
    version: '26.7.5',
    date: '07/2026',
    type: 'minor',
    highlights: [
      '⚡ Chat mượt hơn — bỏ status indicator trên boss mode, tối ưu scroll',
      '🤖 AI chat được lưu vào DB — đổi hội thoại quay lại vẫn giữ lịch sử chat AI, cache trợ lý theo từng thread',
      '🔧 Sửa lỗi Reaction hiển thị 2 lần, không lưu DB, không hiển thị khi đổi hội thoại',
      '🔧 Sửa lỗi "Lỗi lưu workflow" khi dùng kịch bản mẫu',
      '🔍 Tìm kiếm hội thoại hoạt động ở chế độ employee',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Lưu lịch sử chat AI vào DB — bảng ai_conversations + ai_conversation_messages, tự động tạo conversation per (thread + assistant), auto-set title từ tin nhắn đầu',
          'Cache trợ lý AI theo từng hội thoại — chọn assistant ở thread A → chuyển thread B → quay lại thread A → tự động restore assistant đã chọn (persist qua localStorage)',
          'Tìm kiếm hội thoại ở chế độ nhân viên — GlobalSearchPanel gọi DataAccessor.searchConversations() qua boss API khi employee mode, merge với kết quả local',
          'Batch query messages theo IDs — thêm getMessagesByIds IPC, giảm N individual IPC calls thành 1 batch call khi load reply quotes',
        ],
      },
      {
        category: 'improved',
        items: [
          'Gửi tin nhắn nhanh hơn — textarea clear ngay lập tức khi Enter (không đợi setTimeout), bỏ redundant updateStatus trong MessageQueue.enqueue',
          'Ẩn send status indicator (pending/sending/sent/failed) trên boss mode — boss gửi trực tiếp qua Zalo rất nhanh, không cần hiện status; employee mode vẫn giữ',
          'Tối ưu click hội thoại — bỏ activeThreadId dependency khỏi useZaloEvents useEffect (14+ listeners không còn unsub/resub mỗi lần đổi thread)',
          'sendSeenForThread nhận lastMsg từ caller — bỏ redundant DB query khi mở hội thoại',
          'Gộp Zustand updates trong handleSelect — 3-4 setState riêng biệt → 1 useChatStore.setState()',
          'Giảm verbose logging trong DatabaseService.getMessages — bỏ log từng video/fb message chi tiết',
          'Tối ưu scroll — gộp 5 scroll mechanisms thành 1 scrollToBottom() controller duy nhất, dùng stable-height detection thay vì 200ms heuristic',
          'Trang tin nhắn: 50 → 20 tin/trang — load nhanh hơn, ít render hơn',
          'Load tin nhắn cũ ổn định hơn — IntersectionObserver sentinel thay vì atTop state (không bị stale do React batching)',
          'clearDraft: di chuyển IPC call ra ngoài Zustand set() callback — state update thuần, không bị block bởi IPC setup',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi Reaction hiển thị 2 lần trên boss — bỏ UI update cho self-reactions (handleReact đã optimistic update), chỉ persist DB',
          'Sửa lỗi Reaction không lưu DB ở employee mode — parameter mismatch icon vs emoji trong databaseIpc handler',
          'Sửa lỗi Reaction hiển thị 2 lần ở employee mode — REST handler emit event:reaction ngược lại renderer tạo vòng lặp',
          'Sửa lỗi chat.reaction chạy qua message listener tạo duplicate — thêm filter bỏ chat.reaction trong ZaloLoginHelper',
          'Sửa lỗi "Lỗi lưu workflow" khi dùng kịch bản mẫu — else gắn nhầm vào if (res.webhookToken) thay vì if (res?.success)',
          'Sửa lỗi scroll không xuống đáy khi mở hội thoại — messagesReady gate quá sớm, race condition giữa 5 scroll mechanisms',
          'Sửa lỗi load tin nhắn cũ lúc tự load lúc không — atTop state bị stale, thay bằng IntersectionObserver sentinel',
          'Sửa lỗi clearDraft gọi IPC bên trong Zustand set() callback — anti-pattern, di chuyển ra ngoài',
        ],
      },
    ],
  },
  {
    version: '26.7.4',
    date: '07/2026',
    type: 'patch',
    highlights: [
      '🚀 Cập nhật không bắt buộc update bản mới — nút "New version" trên TopBar, xác nhận trước khi tải, tổng hợp ghi chú từ nhiều phiên bản',
      '📱 Chuyển tiếp ảnh/file/video hoạt động đúng với workspace employee — dùng native forward API khi không có file local',
      '🔄 Nhân viên tự kết nối lại — heartbeat không dừng khi mất mạng, tự phục hồi khi có mạng',
      '📄 CRM phân trang tối ưu — bỏ chọn tất cả hàng loạt, thêm nhảy trang + chọn số dòng/trang',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Hệ thống cập nhật mới: không tự động tải, hiển thị nút "New v{version}" trên TopBar cạnh phiên bản hiện tại',
          'Popup xác nhận cập nhật: hiện ghi chú phát hành (tổng hợp từ GitHub nếu bỏ qua nhiều phiên bản), nút "Cập nhật ngay" / "Để sau"',
          'macOS: popup hiển thị link tải Apple Silicon + Intel DMG + nút thử cập nhật tự động',
          'Dashboard: thêm nút "Thêm tài khoản" (giống sidebar) — mở AddAccountModal ngay từ Dashboard',
          'CRM phân trang: nút số trang + nhảy đến trang + chọn 50/100/200/500 dòng mỗi trang',
          'Quét thành viên nhóm: hiển thị role Trưởng nhóm / Phó nhóm khi quét qua backend API (lấy từ getGroupLinkInfo)',
        ],
      },
      {
        category: 'improved',
        items: [
          'Loại bỏ bắt buộc cập nhật: bỏ autoDownload, autoInstallOnAppQuit, đếm ngược tự restart, hệ thống hoãn (postpone)',
          'Ghi chú phát hành: tự động fetch từ GitHub API, tổng hợp tất cả phiên bản giữa phiên bản hiện tại và mới',
          'CRM danh sách liên hệ: bỏ nút "Chọn tất cả" toàn bộ — tránh lag khi 10-50k dòng, chỉ chọn theo trang',
          'Nhân viên tunnel: heartbeat tiếp tục chạy khi disconnected — mỗi 15s thử lại, tự reconnect khi boss reachable',
          'Dashboard: search input nằm cùng hàng với "Kéo thả để sắp xếp thứ tự" để gọn hơn',
        ],
      },
    ],
  },
  {
    version: '26.7.3',
    date: '07/2026',
    type: 'minor',
    highlights: [
      '🔍 CRM Quét thành viên nhóm — quét toàn bộ thành viên từ nhóm Zalo, lưu vào CRM để chạy chiến dịch',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'CRM tab "Quét thành viên" (Premium) — dán link nhóm Zalo, quét thành viên nhóm ẩn/chờ duyệt, hiển thị tên + avatar + UID, tự động lưu vào DB',
        ],
      },
    ],
  },
  {
    version: '26.7.2',
    date: '07/2026',
    type: 'minor',
    highlights: [
      '🔧 Employee mode: sửa lỗi kết nối đến BOSS',
      '⚡ Optimistic Messages: hiển thị tin nhắn ngay khi bấm gửi, không chờ API xác nhận — chat mượt hơn hẳn',
      '🔄 Message Queue: hàng đợi gửi tin thông minh — FIFO, retry tự động, timeout, gửi đa hội thoại song song',
      '🖼️ Gửi nhiều ảnh: preview ngay lập tức, webhook xác nhận từng ảnh, không giật khi chuyển ảnh',
      '🪝 Avatar Retry: tự động nạp lại avatar khi lỗi 403/hết hạn — áp dụng cho cả danh sách chat, sidebar, header',
      '📋 ERP Tasks cho nhân viên: xem/sửa/xoá task qua REST API, tổng quan công việc hoạt động đầy đủ',
      '🔐 ERP Phân quyền: nhân viên chỉ thấy task mình liên quan (giao/theo dõi/tạo), admin xem tất cả',
      '🖼️ Quick Message ảnh: nhân viên upload ảnh lên Boss trước khi lưu — hiển thị đúng ở mọi phía',
      '🔒 Fix Ctrl+Shift+L: phím tắt khoá app hoạt động ngay sau khi bật bảo mật, không cần reset app',
      '🏷️ Workflow: node Đổi tên gợi nhớ Zalo — hỗ trợ biến động, tự cập nhật DB + broadcast cho nhân viên',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'MessageQueue — hệ thống gửi tin nhắn optimistic: hiển thị temp message ngay, enqueue vào hàng đợi, gửi background',
          'Optimistic message fields: send_status (pending/sending/sent/received/failed/timeout), real_msg_id, temp_id, media_type, upload_progress',
          'Status indicators trên bong bông tin: ⏳ pending, ↻ sending, ✓ sent, ✗ failed với nút Gửi lại',
          'buildZaloAuth() helper — chuẩn hóa auth object, luôn kèm accountId để resolveZaloId fallback đúng khi nhiều connections',
          'Avatar retry utility (avatarRetry.ts) — debounce 5 phút, tự detect Zalo/Facebook, retry getUserInfo hoặc refreshContactAvatar',
          'Tách ChatWindowBubbles.tsx từ ChatWindow.tsx — giảm kích thước file, dễ maintain',
          'Tách emojiUtils.ts, messageParser.ts, messageTypeUtils.ts, videoUtils.ts ra lib/chat/',
          'ForwardMessageModal, CreatePollDialog, NoteViewModal, PollBubble, FriendRequestBar, ReactionComponents tách thành component riêng',
          'ERP Tasks REST API cho employee: 12 endpoints (CRUD task, project, assign, watcher, comment, checklist)',
          'ERP Calendar/Profiles/Departments REST API cho employee mode',
          'DataAccessor.erpProjects/Tasks/CreateTask/UpdateTask/DeleteTask/MyInbox/CalendarEvents...',
          'Workflow node zalo.changeAliasName — đổi tên gợi nhớ bạn bè Zalo, hỗ trợ biến {{ $trigger.fromName }}, tự cập nhật DB + broadcast nhân viên',
        ],
      },
      {
        category: 'improved',
        items: [
          'Gửi text/link/like/ảnh/file/video/voice: enqueue vào MessageQueue thay vì await trực tiếp — input không bị block',
          'Gửi nhiều ảnh: preview batch temp giữ nguyên khi upload, webhook đếm ảnh nhận về, xóa temp khi ảnh đầu tiên xác nhận',
          'Gửi ảnh từ thư viện (LibraryPickerModal): tạo temp preview trước khi gửi, enqueue vào MessageQueue',
          'Thư viện ảnh: ưu tiên local path (Boss) hơn HTTP URL (Employee) khi hiển thị thumbnail',
          'Dedup tin nhắn gửi: match bằng real_msg_id trước (chính xác), fallback content text (backward compat)',
          'useZaloEvents + useChatEvents: cập nhật send_status=received khi webhook xác nhận, báo MessageQueue khi nhận self-image',
          'Tất cả UI components chuyển từ inline auth object → buildZaloAuth() — đảm bảo accountId luôn có',
          'Scroll vào hội thoại: đồng bộ trong useLayoutEffect trước khi browser paint — hết giật',
          'erpTaskStore/erpEmployeeStore/erpCalendarStore: tất cả actions dùng DataAccessor khi employee mode',
          'TaskEditorDrawer: load/save/comment/checklist qua DataAccessor — employee mở chi tiết task từ Boss DB',
          'ERP phân quyền: employee chỉ thấy task mình liên quan (assignee/watcher/reporter), admin xem tất cả',
          'Quick Message ảnh: employee upload ảnh lên Boss trước khi lưu QM — hiển thị đúng ở mọi phía',
          'ERP Menu: event permissionUpdate bypass throttle 60s — nhân viên nhận ERP role ngay khi Boss bật quyền',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi giật khi vào hội thoại đã cached — scroll xuống đáy trước khi paint, không thấy content nhảy',
          'Sửa lỗi gửi 2 ảnh nhưng hiện 3 ảnh — xóa batch temp ngay khi webhook đầu tiên đến',
          'Sửa lỗi thumbnail thư viện hiển thị URL sai trên Boss — ưu tiên local-media:// thay vì HTTP API',
          'Sửa lỗi avatar 403 không tự nạp lại — retry tự động cho cả Zalo và Facebook contacts',
          'Sửa lỗi Blocked zalo:getPinConversations khi nhiều connections — buildZaloAuth luôn kèm accountId',
          'Sửa lỗi gửi ảnh từ thư viện không có preview — tạo temp message trước khi enqueue',
          'Sửa lỗi không scroll xuống cuối khi gửi ảnh từ LibraryPickerModal — thêm scrollToBottom event',
          'Sửa lỗi có thể MẤT DỮ LIỆU KHI UPDATE: đóng DB hoàn toàn trước khi NSIS installer chạy (trước đó chỉ flush WAL nhưng không close → file bị lock → silent fallback sang :memory: trống)',
          'Sửa lỗi ERP Menu không hiển thị cho nhân viên — thêm event permissionUpdate, fix INSERT erp_employee_profiles',
          'Sửa lỗi Tổng quan công việc hiển thị 0 task — routing conflict: inbox bị regex tasks/{id} nuốt, đổi thứ tự routes',
          'Sửa lỗi TaskInboxPage loadInbox params lệch — bỏ employeeId thừa từ code cũ JOIN',
          'Sửa lỗi Quick Message ảnh không hiển thị ở employee — upload lên Boss trước khi lưu, dùng toLocalMediaUrl',
          'Sửa lỗi Blocked getPinConversations khi nhiều connections — buildZaloAuth luôn kèm accountId',
          'Fix Ctrl+Shift+L không hoạt động sau khi bật bảo mật trong Cài đặt — App.tsx + TopBar giờ lắng ngự sự kiện lockScreen:changed realtime'
        ],
      },
    ],
  },
  {
    version: '26.7.1',
    date: '07/2026',
    type: 'patch',
    highlights: [
      '🔧 Employee mode: RestQueryService init sớm — fix "Chưa kết nối tới BOSS" khi mới mở app',
      '📹 Video/file employee: stream trực tiếp từ boss URL, không chờ download hết mới mở',
      '🎨 Theme: Sửa icon emoji sang SVG để đảm bảo tương thích với mọi thiết bị, màu tin nhắn sửa lại phù hợp hơn.',
    ],
    changes: [],
  },
  {
    version: '26.7.0',
    date: '07/2026',
    type: 'major',
    highlights: [
      '🏛️ Kiến trúc mới: thay sync data toàn bộ bằng REST API — Employee gọi dữ liệu qua Boss theo từng request, ổn định & bảo mật hơn',
      '📁 Thư viện Media dùng chung — ảnh/file/video có thư mục, upload, tìm kiếm, chọn nhanh khi chat',
      '📡 Socket.IO thay SSE — kết nối realtime giữa Boss & Employee ổn định hơn, ít mất kết nối',
      '⚡ PageLoading toàn app — skeleton loading cho employee mode, không còn màn hình trắng khi chờ REST API',
      '🔁 Kết nối Boss linh hoạt — popup reconnect, ngắt kết nối, lưu mật khẩu, hiển thị latency',
      '📦 Media Cache tự động — employee xem ảnh/video từ workspace cache, download background từ Boss',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Thư viện Media (Library): quản lý ảnh/file/video tập trung, có thư mục, upload qua multipart, thumbnail tự động, chọn từ library khi chat',
          'DataAccessor — lớp trung gian routing UI → IPC hoặc REST API tuỳ mode, không sửa UI component',
          'REST API cho employee: /api/query/* (read), /api/command/* (write), /api/boot (init), /api/media/* (file), /api/library/*, /api/search/*',
          'RestQueryService — REST client cho employee, tự động health check, onStatusChange callback, cache',
          'RestApiHandlers (986 dòng) — 50+ handler: messages, contacts, labels, flags, pins, notes, workflows, campaigns, AI, analytics, library...',
          'MediaCacheService — cache media local cho employee, cascade: workspace → cache → Boss → CDN',
          'EmployeeCache — in-memory cache conversations/messages/labels cho employee, SSE push tự update',
          'Socket.IO — kết nối realtime giữa Boss & Employee thay SSE, attach cùng HTTP server relay',
          'PageLoading component — skeleton loading 4 variants (full/inline/skeleton/overlay), dùng xuyên suốt app',
          'EmployeeSettings: thiết kế lại với tabs Employees/Relay, quick actions start/stop tunnel, search nhân viên, groups panel',
          'TopBar: popup reconnect Boss, ngắt kết nối, lưu mật khẩu localStorage, hiển thị latency real-time',
          'Database: FTS5 full-text search migration, media library tables, withDbPathAsync method',
          'Group member info auto-fetch — khi có tin nhắn nhóm từ sender chưa có tên/avatar, tự getUserInfo từng người, throttle 60s',
        ],
      },
      {
        category: 'improved',
        items: [
          'Xoá cơ chế sync data toàn bộ (syncIpc.ts) — employee không cần chờ sync hàng GB khi vào app',
          'HttpRelayService viết lại lớn: REST API routing, REST cache 1.5s, Socket.IO, xoá sync endpoints',
          'Tất cả UI components chuyển từ ipc.db.xxx → DataAccessor (messages, contacts, labels, notes, analytics, workflow, AI, integration...)',
          'Dashboard: loading state với PageLoading, xoá nút "Đồng bộ từ Boss" cũ',
          'ChatWindow: PageLoading khi load thread, cascade media URL cho employee, fetch thành viên nhóm tự động',
          'MessageBubbles: cascade URL workspace cache → Boss → CDN, employee sticker loading',
          'MediaSection: dùng DataAccessor, reload labels/media khi có change',
          'AnalyticsPage: DataAccessor + PageLoading thay skeleton local cũ',
          'EmployeeLoginScreen: xoá sync progress UI, dùng RestQueryService login',
          'HttpClientService: tái cấu trúc giảm từ 576 xuống ~200 dòng',
          'fileIpc: media:resolveUrl với cache-first, kiểm tra workspace media directory trước',
          'EventBroadcaster: thêm 10+ event mới (library, unread, conversationDeleted, contactProfileUpdated, tagChanged...)',
          'DatabaseService: thêm Logger.log cho getMessages để debug employee routing',
          'WorkflowList: dùng DataAccessor cho employee, cache tránh redundant load',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi employee không load được media local — cascade URL qua workspace cache → Boss → CDN',
          'Sửa lỗi employee login mất token khi restart — lưu & restore từ workspace',
          'Sửa lỗi SSE half-open socket không phát hiện — Socket.IO quản lý connection lifecycle',
          'Sửa lỗi group member hiển thị UID thay vì tên — auto-fetch getUserInfo từng member',
        ],
      },
    ],
  },
  {
    version: '26.6.7',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🌐 Workflow: thêm node Webhooks - nhận và xử lý HTTP request từ bên thứ ba, kích hoạt luồng tự động',
      '🧩 Kho template Webhooks - nhiều mẫu có sẵn để tích hợp nhanh với các dịch vụ ngoài',
      '📍 Hiển thị tin nhắn địa chỉ trên Zalo - parse toạ độ, hiện địa chỉ cụ thể kèm link Google Maps',
      '👥 Sidebar trái: chế độ xem danh sách tài khoản đầy đủ, hỗ trợ tìm kiếm nhanh',
      '🏷️ Lọc nhãn hội thoại nâng cao - chọn "Tất cả" hoặc "Một trong" các nhãn đã chọn',
      '📤 Chiến dịch CRM: random delay giữa các tin nhắn và giữa các liên hệ - tránh spam, tự nhiên hơn',
      '🐛 Sửa lỗi kéo chọn nhiều tin nhắn trong chế độ chọn - thêm phím ESC để thoát nhanh',
      '🐛 Sửa lỗi trình xem ảnh hiện lại sau khi đóng nhanh',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Workflow: node Webhooks - nhận HTTP request (GET/POST/PUT/DELETE) từ hệ thống bên thứ ba, parse body JSON/form-data, truyền biến động vào workflow, phản hồi status tuỳ chỉnh',
          'Kho template Webhooks - các mẫu có sẵn: webhook đơn giản, xác thực signature, tích hợp webhook từ các dịch vụ phổ biến',
          'Hiển thị tin nhắn địa chỉ Zalo - parse toạ độ (lat/lng) từ nội dung tin nhắn, hiển thị tên địa điểm + địa chỉ cụ thể + link mở Google Maps',
          'Sidebar trái: chế độ xem danh sách tài khoản - hiển thị tất cả tài khoản dạng danh sách, tìm kiếm theo tên tài khoản, hỗ trợ nhiều tài khoản dễ quản lý',
        ],
      },
      {
        category: 'improved',
        items: [
          'Lọc nhãn hội thoại: bổ sung chế độ "Tất cả nhãn" (giao tất cả) và "Một trong các nhãn" (giao một) - linh hoạt hơn khi lọc hội thoại theo nhiều nhãn',
          'Chiến dịch CRM: thêm random delay - cấu hình khoảng thời gian delay ngẫu nhiên giữa các tin nhắn và giữa các liên hệ, giúp chiến dịch tự nhiên hơn, tránh bị spam detection',
          'Chế độ chọn nhiều tin nhắn: nhấn ESC để thoát khỏi chế độ chọn nhanh',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi kéo chọn tin nhắn (drag-select) không hoạt động đúng trong chế độ chọn nhiều tin',
          'Sửa lỗi trình xem ảnh bị hiển thị lại lần nữa sau khi đóng nhanh - race condition giữa sự kiện đóng và mở ảnh mới',
        ],
      },
    ],
  },
  {
    version: '26.6.6',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '⌨️ Nâng cấp phím tắt hội thoại: Tab chuyển hội thoại, Ctrl+P ghim, Ctrl+F tìm tin, Ctrl+K tìm hội thoại, Ctrl+N ghi chú, Ctrl+S AI, Ctrl+I thông tin, Ctrl+T tag nhanh',
      '⌨️ Chuyển tài khoản nhanh: giữ Ctrl+Tab → overlay chọn nick, thả Ctrl để chọn, Esc thoát',
      '📁 Tự động xoá media cũ - cài số ngày trong Cài đặt → Tài khoản, dọn mỗi đêm lúc 3AM',
      '📡 Tăng ổn định khi gửi tin Facebook - chống trùng tin, xử lý link đúng, hạn chế mất kết nối',
      '🤖 AI model tuỳ chỉnh - nhập model name bất kỳ cho 9Router & OpenRouter',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Phím tắt hội thoại: Tab/Shift+Tab chuyển hội thoại, Ctrl+P ghim/bỏ ghim, Ctrl+K tìm hội thoại, Ctrl+F tìm tin nhắn, Ctrl+N tạo ghi chú, Ctrl+S mở AI, Ctrl+I mở thông tin, Ctrl+T ẩn/hiện tag nhanh - kèm popup tra cứu',
          'Chuyển tài khoản nhanh Ctrl+Tab: giữ Ctrl + Tab navigate, thả Ctrl để chọn, Shift+Tab prev, Esc thoát; hỗ trợ merged inbox mode (có thêm "Tất cả tài khoản")',
          'Xoá tài khoản triệt để: 2 chế độ - (1) Xoá tất cả dữ liệu: xoá sạch tin nhắn, danh bạ, khách hàng, chiến dịch, workflow, file media; (2) Chỉ xoá tài khoản: giữ nguyên dữ liệu',
          'Tự động xoá media cũ theo ngày - cài đặt số ngày riêng từng tài khoản, hệ thống tự dọn mỗi 3AM',
          'AI: custom model input cho 9Router & OpenRouter - nhập model name bất kỳ, thêm model mới (Big Pickle, Nemotron 3 Ultra, North Mini Code)',
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
      '🖱️ Kéo chuột chọn nhiều tin nhắn - giữ và kéo qua nhiều tin để chọn hàng loạt',
      '✏️ Sửa tên gợi nhớ trực tiếp từ ChatHeader - popup sửa alias nhanh, đồng bộ Zalo API',
      '🎞️ Facebook xử lý hiển thị tin nhắn trích dẫn, video, gif ổn định hơn',
      '🤖 AI hỗ maxTokens tuỳ chỉnh, suggestions 1000 tokens - sử dụng 9Router mượt mà hơn',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Kéo chuột chọn nhiều tin nhắn: pointerdown → drag → pointerup để chọn range tin nhắn, suppress click ngay sau drag',
          'Sửa tên gợi nhớ trực tiếp từ ChatHeader - popup AliasEditPopup, gọi changeFriendAlias + setContactAlias, đồng bộ realtime',
          'Ghim hội thoại local cho Facebook & các kênh không có Zalo API pin - dùng local_pinned_conversations, hiển thị trong GroupInfoPanel + ConversationInfo',
        ],
      },
      {
        category: 'improved',
        items: [
          'Facebook GIF: phát hiện GifPlayback từ E2EE bridge (Go events.go), hiển thị GIF animation thay vì ảnh tĩnh, xử lý ảnh gửi trong container video (mimeType image/)',
          'Facebook video: loading timeout 8s với thông báo "Tải thất bại", skip URL thumbnail ảnh giả (.jpg/.png), fallback att_* keys từ downloadNonE2EEAttachments',
          'Facebook pre-fetch contact info: tự động lấy display_name + avatar từ HTML trước khi broadcast fb:onMessage, FE fallback nếu BE fetch fail',
          'Facebook contact info trong broadcast: gửi kèm contactName + contactAvatar để UI không hiển thị UID/avatar trống',
          'Facebook E2EE: await handleIncomingMessage trước khi download media - tránh race event:localPath đến trước message store',
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
          'Sửa lỗi hiển thị UID thay vì tên trên tin nhắn Facebook mới - pre-fetch contact info trước broadcast, FE fallback',
          'Sửa lỗi race condition E2EE media download: event:localPath đến trước khi message có trong store → local_paths bị mất, video không play được',
          'Sửa lỗi quote_data bị mất khi MQTT echo đến trước persistSentMessage - merge quote_data trong chatStore',
          'Sửa lỗi Facebook group bridge attachments không parse được - parse attachments array từ bridge data cho non-E2EE group messages',
          'Sửa lỗi alias không đồng bộ qua relay cho nhân viên - sắp xếp thứ tự xử lý channel, forward trực tiếp',
          'Sửa lỗi AI chat không parse được response từ server không chuẩn OpenAI format - thêm fallback các format khác',
          'Sửa lỗi E2EE ảnh gửi trong container video không hiển thị - Go bridge detect mimeType image/ trong video container',
          'Sửa lỗi Facebook MQTT attachment ID âm (0, -1, -2) - synthetic ID dùng negative index thay vì hardcode 0',
          'Sửa lỗi Facebook group video không tải được - fallback att_* keys khi tìm local_paths',
          'Sửa lỗi E2EE download lỗi âm thầm - catch + log chi tiết, thông báo bridge không hỗ trợ media type',
        ],
      },
    ],
  },
  {
    version: '26.6.4',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '👤 Tự động refresh avatar Zalo khi khởi động - avatar không còn bị mờ/thiếu do CDN hết hạn',
      '✏️ Facebook E2EE: hỗ trợ xem lịch sử chỉnh sửa tin nhắn - đánh dấu "đã chỉnh sửa" + nút "Xem nội dung cũ"',
      '📞 Gợi ý danh thiếp Zalo từ SĐT trong khung chat - gõ số 0xx, tự động tra cứu và gửi danh thiếp khi Enter',
      '🖼️ Danh thiếp Zalo cải tiến - nút "Kết bạn" trực tiếp, chọn được số điện thoại, click avatar mới mở profile',
      '🚫 Facebook: admin message (pin, poll, đổi tên nhóm) hiển thị đúng dạng thông báo hệ thống',
      'ℹ️ Tự động fetch thông tin user khi vào hội thoại mới - không còn thấy "Unknown" hay avatar mặc định',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Avatar Zalo tự động refresh khi khởi động app - kiểm tra avatar URL còn hạn không (HTTP HEAD), nếu expired thì gọi Zalo API lấy URL mới, cập nhật cả tên hiển thị',
          'Facebook E2EE: hỗ trợ tin nhắn đã chỉnh sửa - lưu edit history, DB migration thêm cột edit_history + is_edited, IPC event fb:onEdit',
          'Gợi ý danh thiếp Zalo khi gõ SĐT trong khung chat - detect pattern 0xx, debounce 800ms, tra cứu local DB + Zalo findUser API + getUserInfo, Enter để gửi danh thiếp thay vì text',
          'Nút "Kết bạn" trên danh thiếp Zalo - kiểm tra trạng thái bạn bè (isFr/is_friend), gửi lời mời trực tiếp với tin nhắn mặc định',
          'Facebook E2EE: xử lý unsend tin nhắn mã hoá - lưu nội dung gốc vào recalled_content',
        ],
      },
      {
        category: 'improved',
        items: [
          'Tự động fetch tên + avatar khi vào hội thoại mới thiếu thông tin (Zalo & Facebook) - áp dụng cho ChatHeader, ConversationInfo, và deep link/notification',
          'Danh thiếp Zalo: click avatar mới mở profile (không block select text), hiển thị SĐT dùng PhoneDisplay (selectable)',
          'Refresh alias dùng getAliasList (count=5000) thay vì gọi getUserInfo từng user - nhanh hơn, không tốn quota API',
          'Facebook E2EE unsend: lưu nội dung gốc vào recalled_content để user có thể xem lại',
          'Facebook: admin message (pin, poll, group info changes) hiển thị dạng system notification centered thay vì chat bubble',
          'Cập nhật contact alias ngay lập tức trong Zustand store khi nhận từ employee relay - không cần chờ refresh',
          'Load contacts từ DB khi nhận deep link - tránh hiển thị danh sách trống trước khi kịp load',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi admin text Facebook (pin, poll, đổi tên nhóm) hiển thị thành message bình thường - giờ là centered system notification',
          'Sửa lỗi avatar Zalo bị mờ/thiếu khi CDN URL hết hạn - tự động HEAD check + refresh khi startup',
          'Sửa lỗi không hiển thị tên contact khi vào hội thoại từ deep link / thông báo desktop - tự động fetch ngay sau khi navigate',
          'Sửa lỗi Facebook alias không được update Zustand store khi nhận từ relay server',
          'Sửa lỗi nhân viên click vào hội thoại không hiển thị tin nhắn (báo "Chưa có tin nhắn nào") - thêm zaloId vào params getMessageHistory và getUserInfo khi proxy sang Boss, giúp Boss resolve đúng tài khoản Zalo cần dùng',
          'Sửa lỗi đồng bộ dữ liệu Boss → Nhân viên timeout với nhiều messages - tăng timeout requestFullSync từ 120s lên 600s, tăng timeout deltaSync từ 60s lên 600s',
          'Sửa lỗi import messages quá chậm (INSERT từng dòng) - batch 200 rows/INSERT, giảm số lần gọi db.exec(), có fallback row-by-row nếu batch lỗi',
          'Sửa lỗi sync thất bại im lặng - thêm retry 3 lần tự động + log lỗi chi tiết nếu sync không hoàn tất',
          'Sửa lỗi upload media qua tunnel timeout với ảnh lớn - tăng timeout uploadMedia từ 60s lên 120s',
          'Sửa lỗi upload nhiều ảnh/ file tuần tự - chuyển sang upload song song (Promise.all)',
        ],
      },
    ],
  },
  {
    version: '26.6.3',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🐧 Hỗ trợ Ubuntu Linux (.AppImage + .deb) - CI/CD build tự động',
      '📡 Kết nối Facebook ổn định hơn - tự động reconnect khi mất kết nối, timeout guard 15s',
      '🤖 Workflow Zalo & Facebook gửi tin đến nhiều hội thoại cùng lúc, AI gợi ý thông minh hơn',
      '📹 Xem video Facebook inline ngay trong chat - tách riêng với video Zalo',
      '📤 Zalo nhân viên: tự động upload file ảnh/video/voice lên boss trước khi proxy',
      '🐛 Sửa lỗi gửi tin Facebook 1:1, E2EE bridge timeout, video Zalo hiển thị sai',
    ],
    changes: [
      {
        category: 'new',
        items: [
          '🐧 Hỗ trợ Ubuntu/Linux - build AppImage + .deb, CI/CD tự động trên GitHub Actions, hướng dẫn cài đặt cho Linux trong README',
          '📹 Xem video Facebook inline ngay trong khung chat (FacebookVideoBubble) - không cần mở ứng dụng ngoài, hỗ trợ E2EE video',
          '➕ Kết bạn Zalo trực tiếp từ kết quả tra cứu số điện thoại trong thanh tìm kiếm toàn cục',
          '📦 Script build bridge E2EE đa nền tảng (build-bridge-e2ee.js) - tự động clone mautrix/meta, build cho Windows/Linux/macOS',
        ],
      },
      {
        category: 'improved',
        items: [
          '📡 Facebook: tự động reconnect khi service bị mất khỏi ConnectionManager (getFBServiceOrReconnect) - không còn lỗi "Account not connected" khi mạng drop rồi online lại',
          '⏱️ Facebook: timeout guard 15s cho gửi tin nhắn qua IPC - UI không bị treo vô hạn khi MQTT/API treo',
          '🔄 Facebook gửi tin nhắn: routing thông minh - 1:1 ưu tiên E2EE bridge, group ưu tiên bridge MQTT, REST fallback',
          '✅ Facebook ensureConnected() trước khi gửi - tránh gửi request qua kết nối đã chết',
          '📤 Workflow Facebook: gửi text/ảnh đến nhiều hội thoại cùng lúc (threadIds array), hỗ trợ continueOnError',
          '📤 Workflow Zalo: gửi message/image/file đến nhiều hội thoại cùng lúc (threadIds), hỗ trợ continueOnError',
          '🤖 AI gợi ý tin nhắn: prompt instruction rõ ràng hơn, thêm fallback split câu nếu AI trả sai format',
          '🔧 9Router AI: base URL placeholder sửa đúng (bỏ /v1) - tương thích với proxy 9Router',
          '🔄 Workflow: phát hiện cycle trong topological sort - log cảnh báo node bị skip',
          '🌐 Zalo IPC: resolveZaloId fallback khi auth không có cookies - gửi tin nhắn nhanh vẫn hoạt động',
          '📤 Zalo IPC Employee: tự động upload file media (ảnh, video, voice) từ máy nhân viên lên boss trước khi proxy - file cục bộ của nhân viên không tồn tại trên boss',
          '📦 Bridge E2EE: cập nhật dependencies (mautrix v0.28.1, libsignal v0.2.2, whatsmeow mới nhất)',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi gửi tin nhắn Facebook 1:1 không qua E2EE bridge khi thread chưa được đánh dấu E2EE',
          'Sửa lỗi Facebook E2EE bridge connect timeout quá dài (120s → 30s) - không block group messaging',
          'Sửa lỗi upload attachment Facebook timeout (120s → 60s) - giảm thời gian chờ khi upload',
          'Sửa lỗi workflow Facebook sendImage không gửi được ảnh đến nhiều thread (thiếu vòng lặp)',
          'Sửa lỗi video Zalo bị ảnh hưởng bởi logic Facebook video - tách riêng ZaloVideoBubble và FacebookVideoBubble',
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
      '🔐 Đăng nhập Facebook bằng tài khoản + mật khẩu + xác thực 2FA - không cần cookie',
      '🔔 Cài đặt thông báo và âm thanh riêng theo từng tài khoản - không cần chung tất cả',
      '📡 Kết nối Facebook ổn định hơn - cải thiện duy trì phiên hoạt động',
      '🤖 Trợ lý AI tích hợp thêm OpenRouter - thêm lựa chọn model AI giá rẻ hoặc miễn phí (author kungfu321)',
      '🐛 Sửa lỗi kết nối model AI Free ở 9Router, workflow chuyển tiếp Zalo, xoá tài khoản còn sót kết nối, và kết nối Sapo',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Đăng nhập Facebook qua tài khoản + mật khẩu + secretKey 2FA - hỗ trợ xác thực hai yếu tố, không cần phải lấy cookie thủ công',
          'Cài đặt thông báo góc màn hình và âm thanh theo từng tài khoản riêng biệt - mỗi tài khoản có thể tuỳ chỉnh thông báo riêng thay vì áp dụng chung một cấu hình cho tất cả',
        ],
      },
      {
        category: 'improved',
        items: [
          'Cải thiện duy trì kết nối Facebook ổn định hơn - giảm tình trạng mất kết nối và tự động phục hồi tốt hơn',
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
      '🤖 Hỗ trợ kênh chat Facebook Messenger (repo fbchat-v2) - đọc/gửi tin nhắn kể cả mã hoá đầu cuối',
      '⚡ Workflow mở rộng - hỗ trợ triggers và actions mới cho Facebook',
      '📊 CRM Quét dữ liệu Facebook - tìm kiếm nhóm, fanpage, bài viết theo từ khoá, quét bình luận, thành viên nhóm, thống kê & xuất Excel',
      '🤖 Trợ lý AI tích hợp thêm 9Router - dịch vụ proxy API AI cho phép bạn gọi các model giá rẻ hoặc miễn phí.',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Facebook E2EE Bridge - binary Go (fbchat-bridge-e2ee.exe) xử lý mã hoá đầu cuối, build tự động qua predev',
          'Facebook E2EE: đọc & gửi tin nhắn, media, sticker, reactions trong hội thoại mã hoá',
          'Facebook: đăng nhập bằng cookie (bỏ beta), hướng dẫn lấy cookie + cảnh báo hết hạn',
          'Facebook: block/unblock user, đổi theme, tạo note, làm mới thông tin user từ HTML (tên + avatar)',
          'Facebook: upload attachment dùng manual multipart body (sửa lỗi 0KB), tải hội thoại cũ',
          'Facebook: FBUserProfilePopup, FBVideoThumb, AccountAssignmentPopup',
          'CRM Quét dữ liệu Facebook: tìm kiếm nhóm/fanpage/bài viết theo từ khoá, quét thành viên nhóm, bình luận bài viết',
          'CRM Scan: auto-pagination với mục tiêu số lượng, batch scan nhiều ID cùng lúc, thread pool',
          'CRM Scan: tab-based sessions - tạo nhiều tab quét, lưu cấu hình & kết quả, xem lịch sử, xuất Excel',
          'CRM Scan: bộ lọc nâng cao - public groups, recent posts, lọc theo năm, từ khoá bình luận, phát hiện SĐT',
          'CRM Scan: thống kê tổng quan - biểu đồ tròn tỷ lệ thành công, thanh so sánh, top tab nhiều dữ liệu, thống kê theo loại quét',
          'CRM Scan: giao diện Chrome-style tabs, tối đa 5 tab hiển thị + overflow menu, đổi tên, lưu trữ, xoá tab',
          'Workflow: Facebook triggers (message, friend request, group, reaction,...) & actions mới',
          'Workflow: TemplateVarPopup - chọn biến động từ danh sách template variables',
          'Workflow: mở rộng workflow templates và workflow config',
          'Hệ thống models module mới - account, ai, contact, crm, employee, facebook, integration, message, proxy, workflow',
          'Integration: Sửa lại giao diện và logic tích hợp AI platforms, thêm 9Router',
          'channelConfig & channelIpc - cấu hình theo từng nền tảng (Zalo, Facebook, Telegram)',
          'useChannelCapability hook - kiểm tra tính năng theo channel',
          'Trang Donate trong IntroductionSettings',
        ],
      },
      {
        category: 'improved',
        items: [
          'Workflow Engine mở rộng - xử lý Facebook events, friend request, reaction, poll, group events',
          'NodeConfigPanel - cấu hình node Facebook, template variables, HTML editor, contact picker',
          'CRM Queue: daily_start_time tách riêng khỏi daily_send_limit, áp dụng cho mọi chiến dịch',
          'CRM CampaignCreateModal: UI daily start time luôn hiển thị, logic cải tiến',
          'CRM CampaignDetail & TargetSelector: dedup phone+UID, tránh trùng SĐT/UID khi import',
          'IntegrationPage thiết kế lại - section AI platforms, saved integrations cải tiến',
          'AIAssistantService cập nhật - hỗ trợ nhiều platform AI',
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
          'Facebook attachment upload lỗi 0KB do form-data không tương thích - dùng manual multipart body',
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
      '📡 Nâng cấp kết nối Boss ↔ Nhân viên - ổn định hơn, tự khôi phục khi mất kết nối, đồng bộ realtime',
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
          'Sửa lỗi workflow không thực thi đúng khi trigger là "Lời mời kết bạn" - chấp nhận và từ chối kết bạn giờ hoạt động bình thường',
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
      '🔄 Tải lại biệt danh (alias) - nút reload trên header và tự động tìm alias mỗi ngày',
      '📊 Log chiến dịch chi tiết hơn - lưu response và lỗi từng block',
      '📡 Nâng cấp kết nối SSE - exponential backoff, tự reconnect khi mất kết nối',
      '📖 Hướng dẫn sử dụng & báo lỗi mới - truy cập nhanh từ TopBar',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Chiến dịch CRM: thêm mode chọn đối tượng theo UID - nhập danh sách UID trực tiếp, tra cứu tên khi gửi',
          'Tải lại biệt danh: nút reload alias trên ChatHeader và ConversationInfo panel cho hội thoại 1-1 trên Zalo',
          'Tự động refresh alias nền mỗi 24 giờ khi mở hội thoại - giữ biệt danh luôn cập nhật',
          'Auto-fetch thông tin liên hệ khi mở hội thoại chỉ có UID (chưa có tên/avatar) - tự động lấy từ API',
          'Tự động tải lại dữ liệu (contacts, flags) sau khi đồng bộ full/delta từ workspace khác',
          'Dashboard: thêm tooltip giải thích cho nút Gộp tài khoản, Thêm workspace và Hỗ trợ khi rê chuột',
          'TopBar: thêm nút truy cập nhanh Hướng dẫn sử dụng và Báo lỗi',
          'Trang Hướng dẫn báo lỗi mới (Cài đặt → Giới thiệu → Hướng dẫn báo lỗi) - quy trình 5 bước với ví dụ mẫu',
          'Health check tự động cho workspace từ xa - kiểm tra và reconnect mỗi 60 giây',
        ],
      },
      {
        category: 'improved',
        items: [
          'Nâng cấp kết nối SSE: exponential backoff (3s → 30s cap), tự reconnect khi heartbeat fail 2 lần liên tiếp',
          'Log chiến dịch CRM: lưu chi tiết API response và error message từng block vào send history',
          'CSV export: SĐT và UID không bị Excel chuyển thành scientific notation (ép dạng text ="...")',
          'Lọc danh sách @mention - ẩn thành viên không có tên hiển thị khỏi gợi ý nhắc đến',
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
      '📊 Giới hạn gửi chiến dịch theo ngày - tự động dừng khi đạt giới hạn, hẹn giờ chạy tiếp ngày sau',
      '🔧 Sửa lỗi chiến dịch gửi ảnh không thành công',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Giới hạn số liên hệ gửi/ngày cho chiến dịch CRM - cài đặt số lượng tối đa và giờ bắt đầu chạy, tự động dừng khi đạt giới hạn và tiếp tục vào ngày mới. Nếu giờ đã qua hôm nay, chiến dịch chạy ngay.',
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
      '🔒 khoá màn hình - bảo vệ ứng dụng bằng mật khẩu, sinh trắc học và recovery key',
      '☑️ Chọn nhiều tin nhắn - chọn và chuyển tiếp/sao chép nhiều tin cùng lúc',
      '🖼️ Tự động sửa ảnh lỗi - ảnh hỏng được tải lại ngầm, không cần thao tác',
      '📞 CRM nhập SĐT nhanh hơn - không cần chờ tra cứu, tự động xử lý khi gửi',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Khoá màn hình: đặt mật khẩu bảo vệ ứng dụng, phím tắt Ctrl+Shift+L để khoá nhanh, nút khoá trên thanh tiêu đề',
          'Chọn nhiều tin nhắn: nhấn chuột phải → "Chọn tin nhắn" để chọn nhiều tin, sau đó sao chép hoặc chuyển tiếp hàng loạt',
          'Chuyển tiếp nhiều tin cùng lúc: chọn nhiều tin nhắn và nhiều người nhận, gửi lần lượt tự động',
          'Tự động phát hiện và sửa ảnh bị lỗi (ảnh trắng, 0 byte, nội dung HTML) khi mở cuộc trò chuyện',
          'Hiển thị thông báo khi ẩn ứng dụng xuống tray - cho biết app vẫn chạy ngầm và nhận tin nhắn',
        ],
      },
      {
        category: 'improved',
        items: [
          'Chiến dịch CRM: nhập số điện thoại nhanh hơn - không cần chờ tra cứu Zalo, tự động tìm người dùng khi gửi chiến dịch',
          'Chiến dịch CRM: gửi nhiều nội dung báo lỗi chính xác hơn - biết block nào gửi thành công, block nào thất bại',
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
      '💬 Nâng cấp chuyển tiếp tin nhắn - hỗ trợ mọi loại, thêm soạn text kèm',
      '📊 Chiến dịch CRM thông minh hơn - auto load thông tin từ tệp số điện thoại',
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
      '🌐 Kết nối nhân viên qua WAN - boss và nhân viên giờ có thể làm việc từ bất kỳ đâu, không chỉ cùng mạng LAN',
      '🔒 Nâng cấp quản lý Proxy - chọn proxy riêng cho từng tài khoản trước khi đăng nhập',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Hỗ trợ kết nối nhân viên qua WAN: Boss bật Cloudflare Tunnel - app tự tạo URL công khai an toàn, nhân viên nhập URL đó để kết nối từ xa mà không cần cùng mạng nội bộ',
          'Thêm nút "Bật Tunnel WAN" trong Cài đặt → Nhân viên → Relay Server - một click để tạo địa chỉ truy cập từ xa',
          'Thêm màn hình cài đặt Proxy trước khi đăng nhập tài khoản Zalo - hỗ trợ HTTP, HTTPS và SOCKS5',
          'Mỗi tài khoản Zalo có thể gán proxy độc lập - không ảnh hưởng đến các tài khoản khác trong cùng app, một proxy có thể gắn nhiều tài khoản.',
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
          'Sửa lỗi phân trang khi quét thành viên từ link nhóm - giờ quét đủ toàn bộ thành viên thay vì chỉ dừng ở 100',
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
          'Sửa lỗi thanh gợi ý sticker khi chat - cuộn chuột trên thanh sticker giờ trượt ngang tự nhiên',
          'Sửa lỗi hiển thị ảnh trong tin nhắn - giảm hiện tượng giật/nháy khi tải ảnh',
          'Sửa lỗi trình xem ảnh - không còn nháy khi mở, kéo ảnh để zoom không còn tự đóng hộp thoại',
        ],
      },
    ],
  },
  {
    version: '26.4.0',
    date: '04/2026',
    type: 'major',
    highlights: [
      '🚀 Ra mắt Deplao - nền tảng desktop vận hành bán hàng và chăm sóc khách hàng trên Zalo trong một ứng dụng duy nhất',
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
  major:  { label: 'Bản lớn',  cls: 'bg-primary/10 text-primary' },
  minor:  { label: 'Cập nhật', cls: 'bg-muted text-foreground' },
  patch:  { label: 'Sửa nhỏ',  cls: 'bg-muted text-muted-foreground' },
  hotfix: { label: 'Sửa gấp',  cls: 'bg-destructive/10 text-destructive' },
};

const CATEGORY_STYLES: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
  new:      { icon: <SparklesIcon className="w-4 h-4" />, label: 'Tính năng mới',   cls: 'text-success' },
  improved: { icon: <LightningIcon className="w-4 h-4" />, label: 'Cải thiện',        cls: 'text-primary' },
  fixed:    { icon: <BugIcon className="w-4 h-4" />, label: 'Sửa lỗi',          cls: 'text-warning' },
  removed:  { icon: <TrashIcon className="w-4 h-4" />, label: 'Đã xóa',           cls: 'text-destructive' },
  security: { icon: <LockIcon className="w-4 h-4" />, label: 'Bảo mật',          cls: 'text-info' },
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
    <SettingsPage
      title="Log phiên bản"
      description={`Phiên bản hiện tại: v${CHANGELOG[0]?.version} · ${CHANGELOG[0]?.date}`}
      width="wide"
      actions={(
        <>
          <Button variant="ghost" size="sm" onClick={expandAll}>Mở rộng tất cả</Button>
          <Button variant="ghost" size="sm" onClick={collapseAll}>Thu gọn</Button>
        </>
      )}
    >
      <div className="space-y-3">
        {CHANGELOG.map((entry, idx) => {
          const isExpanded = expandedVersions.has(entry.version);
          const typeStyle = TYPE_STYLES[entry.type];
          const isLatest = idx === 0;

          return (
            <div key={entry.version}
              className={`overflow-hidden rounded-xl border bg-card transition-colors ${isLatest ? 'border-primary/40' : 'border-border/60'}`}>
              {/* Header */}
              <button
                type="button"
                aria-expanded={isExpanded}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
                onClick={() => toggle(entry.version)}
              >
                <span className="flex-1 text-sm font-semibold text-foreground">
                  v{entry.version}
                  {isLatest && (
                    <span className="ml-2 rounded-full bg-success/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-success">
                      Mới nhất
                    </span>
                  )}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${typeStyle.cls}`}>{typeStyle.label}</span>
                <span className="w-16 text-right text-xs text-muted-foreground">{entry.date}</span>
                <ChevronDownIcon className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
              </button>

              {/* Body */}
              {isExpanded && (
                <div className="space-y-4 border-t border-border/60 px-4 pb-4 pt-3">
                  {/* Highlights */}
                  {entry.highlights && entry.highlights.length > 0 && (
                    <div className="space-y-1.5 rounded-lg bg-muted px-3 py-2.5">
                      {entry.highlights.map((h, i) => (
                        <p key={i} className="text-sm font-medium text-foreground">{h}</p>
                      ))}
                    </div>
                  )}

                  {/* Change categories */}
                  {entry.changes.map((group, gi) => {
                    const style = CATEGORY_STYLES[group.category];
                    return (
                      <div key={gi} className="space-y-1.5">
                        <p className={`flex items-center gap-1.5 text-xs font-semibold ${style.cls}`}>
                          <span>{style.icon}</span>
                          {style.label}
                        </p>
                        <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground marker:text-subtle-foreground">
                          {group.items.map((item, ii) => (
                            <li key={ii}>{item}</li>
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
    </SettingsPage>
  );
}
