import React from 'react';
import ipc from '@/lib/ipc';
import { ActivityIcon, AlertIcon, BookIcon, BugIcon, CheckIcon, ClipboardListIcon, CloseIcon, EditIcon, LightningIcon, LinkIcon, SearchIcon, StarIcon, UsersIcon, WifiIcon } from '@/components/common/icons';
import { BulletList, Card, SectionTitle, StepList } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export function BugReportPanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-destructive leading-none mt-0.5"><BugIcon className="w-8 h-8" /></span>
        <div>
          <h3 className="text-foreground font-bold text-base">{tr('Hướng dẫn báo lỗi')}</h3>
          <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">
            {trx('Tìm thấy lỗi? Báo cáo chi tiết giúp nhóm phát triển xác định và sửa lỗi nhanh hơn.<0> Báo cáo có bước tái hiện, ảnh chụp và nhật ký lỗi rõ ràng sẽ được ưu tiên xử lý trước.</0>', { 0: <strong className="text-warning" /> })}
          </p>
          <p className="text-muted-foreground text-[11px] mt-1">
            {trx('Mở nhanh trang này: nút <0>⋯</0> trên thanh tiêu đề → <1>Báo lỗi</1>.', { 0: <strong className="text-foreground" />, 1: <strong className="text-foreground" /> })}
          </p>
        </div>
      </div>

      <div className="flex justify-center gap-2">
        <button
          onClick={() => ipc.shell?.openExternal('https://github.com/babyvibe/deplao-builder/issues/new')}
          className="px-4 py-2 bg-primary hover:bg-primary-hover text-primary-foreground text-xs font-medium rounded-lg transition-colors"
        >
          {tr('Tạo Issue mới trên GitHub →')}
        </button>
        <button
          onClick={() => ipc.shell?.openExternal('https://github.com/babyvibe/deplao-builder/issues')}
          className="px-4 py-2 bg-muted hover:bg-accent text-foreground text-xs font-medium rounded-lg transition-colors"
        >
          {tr('Xem danh sách Issues')}
        </button>
      </div>

      <Card>
        <SectionTitle>{trx('<0/> Quy trình báo lỗi - 5 bước', { 0: <EditIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <StepList steps={[
          {
            title: tr('Tái hiện lỗi'),
            desc: tr('Lặp lại thao tác và ghi từng bước (VD: "Mở CRM → Chiến dịch → Tạo chiến dịch mới → Lỗi"). Ghi rõ lỗi xảy ra mỗi lần hay chỉ thỉnh thoảng. Cập nhật lên bản mới nhất rồi thử lại — khi có bản mới, cạnh số phiên bản trên thanh tiêu đề hiện nút "New v…".'),
          },
          {
            title: tr('Chụp ảnh / quay video minh hoạ'),
            desc: tr('Chụp màn hình khi lỗi xuất hiện (Windows: PrtScn / Snipping Tool; macOS: Cmd+Shift+4). Lỗi qua nhiều bước: quay video ngắn 10-30 giây (Windows: Win+G; macOS: Cmd+Shift+5). Khoanh hoặc đánh dấu chỗ bị lỗi trên ảnh.'),
          },
          {
            title: tr('Lấy nhật ký lỗi'),
            desc: tr('Ngay sau khi lỗi xảy ra (trước khi tắt app): <strong class="text-foreground">Cài đặt → Nhật ký</strong> → chọn "LỖI" (hoặc "CẢNH BÁO"), gõ từ khoá vào ô "Tìm trong log..." nếu cần → bấm <strong class="text-foreground">Copy</strong> để dán vào issue, hoặc <strong class="text-foreground">Xuất file</strong> để đính kèm file .txt.'),
          },
          {
            title: tr('Ghi thông tin môi trường'),
            desc: tr('Phiên bản Deplao (cạnh chữ Deplao ở góc trên bên trái, hoặc Cài đặt → Log phiên bản); hệ điều hành (Windows 10/11, macOS Intel / Apple Silicon, Linux); kênh và loại tài khoản gặp lỗi (Zalo cá nhân / Business, Facebook, Telegram, Telegram Bot); dùng trên máy Boss, máy nhân viên hay dùng một mình; tính năng liên quan.'),
          },
          {
            title: tr('Tạo issue trên GitHub và theo dõi'),
            desc: tr('Tiêu đề ngắn gọn; "Mô tả lỗi" 1-2 câu; "Bước tái hiện" đánh số; "Kết quả mong đợi" và "Kết quả thực tế"; đính kèm ảnh / video / nhật ký; "Thông tin môi trường". Gửi xong, theo dõi email thông báo, trả lời sớm khi nhóm hỏi thêm và xác nhận lại sau khi cập nhật bản sửa.'),
          },
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Về Nhật ký (Cài đặt → Nhật ký)', { 0: <ClipboardListIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Ghi lại hoạt động và lỗi của app theo thời gian thực (gửi tin, kết nối tài khoản, đồng bộ, workflow…), lọc theo mức: Tất cả, LỖI, CẢNH BÁO, INFO, LOG, DEBUG.'),
          tr('Chỉ giữ khoảng 2.000 dòng gần nhất của lần mở app hiện tại — tắt / mở lại app là mất, nên lấy nhật ký ngay khi vừa gặp lỗi.'),
          tr('App tự che phần lớn mật khẩu, token, cookie trong nhật ký; vẫn nên đọc lại và xoá tên, số điện thoại hay nội dung tin nhắn của khách trước khi gửi.'),
          tr('Lỗi liên quan nhân viên: lấy nhật ký ở cả máy Boss và máy nhân viên.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Ví dụ: Báo cáo lỗi chất lượng cao', { 0: <BookIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="bg-muted rounded-lg border border-border/50 p-3 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="bg-destructive/15 text-destructive text-[10px] px-2 py-0.5 rounded-full font-medium">{tr('bug')}</span>
            <span className="text-foreground font-semibold">{tr('Chiến dịch CRM: Không gửi được tin khi chọn hơn 100 liên hệ')}</span>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            {trx('<0>Mô tả:</0> Khi chạy chiến dịch gửi tin với hơn 100 người nhận, bấm "Bắt đầu" không có phản hồi. Nhật ký (lọc LỖI) có dòng báo timeout.', { 0: <strong className="text-foreground" /> })}
          </p>
          <div className="text-muted-foreground leading-relaxed space-y-1">
            <p><strong className="text-foreground">{tr('Bước tái hiện:')}</strong></p>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li>{tr('Mở CRM → Chiến dịch → Tạo chiến dịch mới')}</li>
              <li>{tr('Thêm liên hệ: tất cả liên hệ có nhãn "Khách hàng" (~150 người)')}</li>
              <li>{tr('Nhập nội dung tin nhắn → Tạo chiến dịch → bấm "Bắt đầu"')}</li>
              <li>{tr('→ Trạng thái không đổi, không có tin nào được gửi')}</li>
            </ol>
          </div>
          <p className="text-muted-foreground leading-relaxed">
            {trx('<0>Môi trường:</0> Deplao v26.11.2, Windows 11, Zalo cá nhân, dùng một mình (không có nhân viên). Đã thử 50 người (bình thường), 100 người (bình thường), 150 người (lỗi). Đính kèm: ảnh chụp + file nhật ký.', { 0: <strong className="text-foreground" /> })}
          </p>
          <div className="bg-success/10 border border-success/30 rounded-lg p-2 mt-2">
            <p className="text-[11px] text-success">
              {trx('<0/> Báo cáo này có: bước tái hiện chính xác, so sánh kết quả, nhật ký lỗi và thông tin môi trường đủ để xác định lỗi.', { 0: <CheckIcon className="w-4 h-4 inline" /> })}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Các loại lỗi thường gặp', { 0: <SearchIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            { icon: <CloseIcon className="w-4 h-4" />, type: 'Lỗi crash / treo app', tips: tr('Ghi thao tác cuối trước khi lỗi, chụp màn hình. Nếu app còn mở được: Cài đặt → Nhật ký → Xuất file.') },
            { icon: <StarIcon className="w-4 h-4" />, type: 'Lỗi giao diện / hiển thị', tips: tr('Ảnh chụp hiện tại và mong đợi. Ghi giao diện Sáng / Tối, hệ điều hành, độ phân giải, cỡ chữ (nút ⋯ → Cỡ chữ).') },
            { icon: <WifiIcon className="w-4 h-4" />, type: 'Lỗi kết nối / đồng bộ tài khoản', tips: tr('Ghi kênh (Zalo, Facebook, Telegram) và tài khoản bị lỗi, thời điểm, trạng thái trên Dashboard. Thử kết nối / đăng nhập lại, kiểm tra Proxy nếu có gắn.') },
            { icon: <UsersIcon className="w-4 h-4" />, type: 'Lỗi kết nối nhân viên', tips: tr('Ghi LAN hay Internet, loại địa chỉ (tạm / cố định), trạng thái trên thanh tiêu đề máy nhân viên và mục Cài đặt → Nhân viên → Kết nối của máy Boss.') },
            { icon: <LinkIcon className="w-4 h-4" />, type: 'Lỗi tích hợp bên thứ 3', tips: tr('Ghi rõ tích hợp nào (POS, vận chuyển, thanh toán…), thao tác, kết quả mong đợi và thực tế. Không dán API key vào issue.') },
            { icon: <LightningIcon className="w-4 h-4" />, type: 'Lỗi Workflow không chạy', tips: tr('Chụp sơ đồ workflow, ghi trigger + action; mở "Lịch sử chạy" trong trình sửa workflow để xem bước bị lỗi.') },
            { icon: <ActivityIcon className="w-4 h-4" />, type: 'Hiệu năng chậm / lag', tips: tr('Ghi quy mô dữ liệu (số tài khoản, hội thoại, nhóm), thao tác bị chậm, so sánh với phiên bản trước.') },
          ].map((item, i) => (
            <div key={i} className="bg-muted rounded-lg p-2.5 border border-input/30">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-muted-foreground">{item.icon}</span>
                <p className="text-[11px] font-semibold text-foreground">{item.type}</p>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{item.tips}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>{trx('<0/> Những điều KHÔNG nên làm', { 0: <AlertIcon className="w-4 h-4 inline" /> })}</SectionTitle>
        <BulletList items={[
          tr('Gửi issue chỉ ghi "app bị lỗi" mà không có mô tả chi tiết'),
          tr('Gửi nhiều issue trùng lặp — tìm trong danh sách Issues trước'),
          tr('Đính kèm thông tin nhạy cảm: mã OTP, mật khẩu, API key / token, cookie, số điện thoại hay tin nhắn của khách'),
          tr('Dùng issue để hỏi cách sử dụng — đọc Cài đặt → Giới thiệu trước, hoặc hỏi qua nút ⋯ → Hỗ trợ trên thanh tiêu đề'),
          tr('Gộp nhiều lỗi khác nhau vào một issue — mỗi issue một lỗi để dễ theo dõi và xác nhận khi đã sửa'),
          tr('Gộp đề xuất tính năng vào báo lỗi — tạo issue riêng cho đề xuất'),
        ]} />
      </Card>
    </div>
  );
}
