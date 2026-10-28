import React from 'react';
import ipc from '@/lib/ipc';
import { FileTextIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle } from './introUi';

const ISSUES_URL = 'https://github.com/babyvibe/deplao-builder/issues';

export function PolicyPanel() {
  return (
    <div className="space-y-4">
      <div className="bg-primary/5 border border-primary/30 rounded-xl p-4">
        <p className="text-primary text-xs font-semibold mb-1"><FileTextIcon className="w-4 h-4 inline" /> Chính sách sử dụng & Tuyên bố miễn trách nhiệm pháp lý</p>
        <p className="text-muted-foreground text-[11px]">Phiên bản 1.0 - có hiệu lực từ ngày 01/01/2025</p>
      </div>

      <Card>
        <SectionTitle>1. Mục đích sử dụng hợp pháp</SectionTitle>
        <Paragraph>
          Deplao là phần mềm hỗ trợ quản lý giao tiếp trên các nền tảng Zalo, Facebook, Telegram dành cho mục đích
          <strong className="text-foreground font-semibold"> kinh doanh hợp pháp</strong>, chăm sóc khách hàng và Tự động hoá quy trình làm việc.
          Phần mềm <strong className={"text-foreground"}>không được thiết kế</strong> và <strong className={"text-foreground"}>không khuyến khích sử dụng</strong> cho các hành vi:
        </Paragraph>
        <BulletList items={[
          'Gửi tin nhắn spam, quảng cáo hàng loạt không có sự đồng ý của người nhận',
          'Thu thập thông tin cá nhân trái phép',
          'Phát tán nội dung vi phạm pháp luật, nội dung khiêu dâm, bạo lực',
          'Lừa đảo, gian lận, hoặc bất kỳ hành vi vi phạm pháp luật Việt Nam nào',
          'Vi phạm Điều khoản dịch vụ của Zalo, Facebook, Telegram',
        ]} />
      </Card>

      <Card>
        <SectionTitle>2. Dữ liệu người dùng & Quyền riêng tư</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Dữ liệu lưu hoàn toàn cục bộ</strong> trên máy tính của người dùng. Chúng tôi <em>không</em> thu thập, lưu trữ hoặc xử lý nội dung tin nhắn, danh bạ hay thông tin khách hàng của bạn trên bất kỳ server nào của chúng tôi.',
          '<strong class="text-foreground">Không chia sẻ với bên thứ 3</strong>: Deplao không tích hợp bất kỳ SDK thu thập dữ liệu, analytics hay quảng cáo của bên thứ 3.',
          '<strong class="text-foreground">Phiên Zalo</strong>: Cookie phiên Zalo được mã hóa AES và lưu cục bộ, chỉ dùng để duy trì kết nối Zalo từ máy bạn.',
          '<strong class="text-foreground">Tin nhắn tự xoá trên Zalo</strong>: khi hội thoại bật "Tự xoá tin nhắn", Zalo xoá tin trên các thiết bị Zalo nhưng Deplao <em>vẫn giữ</em> bản đã lưu trên máy bạn (và trong bản sao lưu nếu có).',
          '<strong class="text-foreground">Đám mây và Public API là tuỳ chọn, mặc định tắt</strong>: lưu media, sao lưu dữ liệu lên Cloudflare R2 hoặc Google Drive chỉ chạy khi bạn tự kết nối tài khoản Cloudflare / Google <em>của chính bạn</em> và bật tính năng (bản sao lưu cơ sở dữ liệu được mã hoá ngay trên máy trước khi tải lên). Public API chạy ngay trên máy bạn và chỉ gọi được bằng API key do bạn tạo.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>3. Yêu cầu vận hành 24/7</SectionTitle>
        <Paragraph>
          Để các tính năng Tự động hoá (Workflow, nhắn tin theo lịch, nhận tin nhắn thời gian thực) hoạt động liên tục,
          ứng dụng cần được <strong className="text-foreground font-semibold">để chạy nền 24/7</strong> trên máy tính.
          Người dùng chịu trách nhiệm đảm bảo máy tính có nguồn điện ổn định và kết nối Internet.
          Việc tắt máy hoặc ngắt kết nối Internet sẽ làm gián đoạn các automation đang chạy.
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle>4. Tuyên bố miễn trách nhiệm</SectionTitle>
        <BulletList items={[
          'Deplao là công cụ hỗ trợ. Người dùng <strong class="text-foreground">hoàn toàn chịu trách nhiệm</strong> về cách sử dụng phần mềm và tuân thủ pháp luật hiện hành.',
          'Chúng tôi không chịu trách nhiệm nếu tài khoản Zalo của bạn bị Zalo hạn chế do sử dụng không đúng cách hoặc vi phạm điều khoản Zalo.',
          'Dữ liệu lưu trên máy bạn là trách nhiệm của bạn. Hãy sao lưu định kỳ để tránh mất mát.',
          'Phần mềm được cung cấp "nguyên trạng" (as-is). Chúng tôi không đảm bảo phần mềm hoạt động hoàn toàn không có lỗi trong mọi môi trường.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>5. Liên hệ & Báo lỗi</SectionTitle>
        <BulletList items={[
          'Báo lỗi, góp ý hoặc cần hỗ trợ: <strong class="text-foreground">github.com/babyvibe/deplao-builder/issues</strong>',
        ]} />
        <button
          onClick={() => ipc.shell?.openExternal(ISSUES_URL)}
          className="text-[11px] text-primary hover:underline text-left"
        >
          Mở trang Issues trên GitHub →
        </button>
      </Card>
    </div>
  );
}
