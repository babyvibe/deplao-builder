import React from 'react';
import ipc from '@/lib/ipc';
import { FileTextIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle } from './introUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const ISSUES_URL = 'https://github.com/babyvibe/deplao-builder/issues';

export function PolicyPanel() {
  return (
    <div className="space-y-4">
      <div className="bg-primary/5 border border-primary/30 rounded-xl p-4">
        <p className="text-primary text-xs font-semibold mb-1">{trx('<0/> Chính sách sử dụng & Tuyên bố miễn trách nhiệm pháp lý', { 0: <FileTextIcon className="w-4 h-4 inline" /> })}</p>
        <p className="text-muted-foreground text-[11px]">{tr('Phiên bản 1.0 - có hiệu lực từ ngày 01/01/2025')}</p>
      </div>

      <Card>
        <SectionTitle>{tr('1. Mục đích sử dụng hợp pháp')}</SectionTitle>
        <Paragraph>
          {trx('Deplao là phần mềm hỗ trợ quản lý giao tiếp trên các nền tảng Zalo, Facebook, Telegram dành cho mục đích<0> kinh doanh hợp pháp</0>, chăm sóc khách hàng và Tự động hoá quy trình làm việc. Phần mềm <1>không được thiết kế</1> và <2>không khuyến khích sử dụng</2> cho các hành vi:', { 0: <strong className="text-foreground font-semibold" />, 1: <strong className={"text-foreground"} />, 2: <strong className={"text-foreground"} /> })}
        </Paragraph>
        <BulletList items={[
          tr('Gửi tin nhắn spam, quảng cáo hàng loạt không có sự đồng ý của người nhận'),
          tr('Thu thập thông tin cá nhân trái phép'),
          tr('Phát tán nội dung vi phạm pháp luật, nội dung khiêu dâm, bạo lực'),
          tr('Lừa đảo, gian lận, hoặc bất kỳ hành vi vi phạm pháp luật Việt Nam nào'),
          tr('Vi phạm Điều khoản dịch vụ của Zalo, Facebook, Telegram'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{tr('2. Dữ liệu người dùng & Quyền riêng tư')}</SectionTitle>
        <BulletList items={[
          tr('<strong class="text-foreground">Dữ liệu lưu hoàn toàn cục bộ</strong> trên máy tính của người dùng. Chúng tôi <em>không</em> thu thập, lưu trữ hoặc xử lý nội dung tin nhắn, danh bạ hay thông tin khách hàng của bạn trên bất kỳ server nào của chúng tôi.'),
          tr('<strong class="text-foreground">Không chia sẻ với bên thứ 3</strong>: Deplao không tích hợp bất kỳ SDK thu thập dữ liệu, analytics hay quảng cáo của bên thứ 3.'),
          tr('<strong class="text-foreground">Phiên Zalo</strong>: Cookie phiên Zalo được mã hóa AES và lưu cục bộ, chỉ dùng để duy trì kết nối Zalo từ máy bạn.'),
          tr('<strong class="text-foreground">Tin nhắn tự xoá trên Zalo</strong>: khi hội thoại bật "Tự xoá tin nhắn", Zalo xoá tin trên các thiết bị Zalo nhưng Deplao <em>vẫn giữ</em> bản đã lưu trên máy bạn (và trong bản sao lưu nếu có).'),
          tr('<strong class="text-foreground">Đám mây và Public API là tuỳ chọn, mặc định tắt</strong>: lưu media, sao lưu dữ liệu lên Cloudflare R2 hoặc Google Drive chỉ chạy khi bạn tự kết nối tài khoản Cloudflare / Google <em>của chính bạn</em> và bật tính năng (bản sao lưu cơ sở dữ liệu được mã hoá ngay trên máy trước khi tải lên). Public API chạy ngay trên máy bạn và chỉ gọi được bằng API key do bạn tạo.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{tr('3. Yêu cầu vận hành 24/7')}</SectionTitle>
        <Paragraph>
          {trx('Để các tính năng Tự động hoá (Workflow, nhắn tin theo lịch, nhận tin nhắn thời gian thực) hoạt động liên tục, ứng dụng cần được <0>để chạy nền 24/7</0> trên máy tính. Người dùng chịu trách nhiệm đảm bảo máy tính có nguồn điện ổn định và kết nối Internet. Việc tắt máy hoặc ngắt kết nối Internet sẽ làm gián đoạn các automation đang chạy.', { 0: <strong className="text-foreground font-semibold" /> })}
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle>{tr('4. Tuyên bố miễn trách nhiệm')}</SectionTitle>
        <BulletList items={[
          tr('Deplao là công cụ hỗ trợ. Người dùng <strong class="text-foreground">hoàn toàn chịu trách nhiệm</strong> về cách sử dụng phần mềm và tuân thủ pháp luật hiện hành.'),
          tr('Chúng tôi không chịu trách nhiệm nếu tài khoản Zalo của bạn bị Zalo hạn chế do sử dụng không đúng cách hoặc vi phạm điều khoản Zalo.'),
          tr('Dữ liệu lưu trên máy bạn là trách nhiệm của bạn. Hãy sao lưu định kỳ để tránh mất mát.'),
          tr('Phần mềm được cung cấp "nguyên trạng" (as-is). Chúng tôi không đảm bảo phần mềm hoạt động hoàn toàn không có lỗi trong mọi môi trường.'),
        ]} />
      </Card>

      <Card>
        <SectionTitle>{tr('5. Liên hệ & Báo lỗi')}</SectionTitle>
        <BulletList items={[
          tr('Báo lỗi, góp ý hoặc cần hỗ trợ: <strong class="text-foreground">github.com/babyvibe/deplao-builder/issues</strong>'),
        ]} />
        <button
          onClick={() => ipc.shell?.openExternal(ISSUES_URL)}
          className="text-[11px] text-primary hover:underline text-left"
        >
          {tr('Mở trang Issues trên GitHub →')}
        </button>
      </Card>
    </div>
  );
}
