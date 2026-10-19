import React from 'react';
import { AlertIcon, CheckCircleIcon, CloudIcon, HardDriveIcon, KeyIcon, LockIcon, ShieldIcon } from '@/components/common/icons';
import { BulletList, Card, Paragraph, SectionTitle, StepList } from './introUi';

/** Hộp cảnh báo (màu theo token warning, đúng cả theme Sáng / Tối). */
function WarningBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 bg-warning/10 border border-warning/30 rounded-lg px-3 py-3">
      <AlertIcon className="w-5 h-5 text-warning flex-shrink-0" />
      <div className="space-y-1.5">
        <p className="text-warning text-xs font-semibold">{title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

const CODE_CLASS = 'font-mono text-[11px] text-foreground bg-muted px-1.5 py-0.5 rounded';

export function SecurityPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle><LockIcon className="w-4 h-4 inline" /> Dữ liệu &amp; phiên đăng nhập</SectionTitle>
        <Paragraph>
          Deplao chạy và lưu dữ liệu ngay trên máy tính của bạn. Đám mây, Public API hay kết nối nhân viên đều là tuỳ chọn, chỉ hoạt động khi bạn tự bật.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Lưu trên máy:</strong> tin nhắn, danh bạ, CRM, cài đặt và ảnh / video / file đều nằm trong thư mục dữ liệu trên máy (xem đường dẫn ở Cài đặt → Lưu trữ).',
          '<strong class="text-foreground">Không qua máy chủ của Deplao:</strong> app kết nối thẳng từ máy bạn tới Zalo, Facebook, Telegram (qua proxy nếu bạn gán); nội dung tin nhắn, danh bạ không được gửi về máy chủ của Deplao.',
          '<strong class="text-foreground">Không lưu mật khẩu tài khoản:</strong> Zalo đăng nhập bằng QR / cookie; mật khẩu Facebook, Telegram chỉ dùng lúc đăng nhập. App chỉ giữ phiên đăng nhập (cookie, token) trên máy này, mã hoá bằng cơ chế bảo mật của hệ điều hành (phiên Zalo, Telegram, token bot, cookie Facebook) — chép thư mục dữ liệu sang máy hoặc tài khoản Windows khác thì phải đăng nhập lại.',
          '<strong class="text-foreground">Máy nhân viên không giữ dữ liệu gốc:</strong> dữ liệu được lấy từ máy Boss qua kết nối; máy nhân viên chỉ có bộ nhớ đệm ảnh / video / file (tự xoá file cũ nhất khi vượt 2 GB).',
        ]} />
      </Card>

      <Card>
        <SectionTitle><ShieldIcon className="w-4 h-4 inline" /> Khoá màn hình ứng dụng</SectionTitle>
        <Paragraph>Đặt mật khẩu để người khác không mở được Deplao trên máy của bạn.</Paragraph>
        <StepList steps={[
          { title: 'Bật khoá', desc: 'Cài đặt → <strong class="text-foreground">Bảo mật</strong> → đặt mật khẩu (tối thiểu 4 ký tự), nhập lại → <em>Bật khoá màn hình</em>. Từ đó app hỏi mật khẩu mỗi khi mở.' },
          { title: 'Lưu Recovery Key', desc: 'App tạo một mã khôi phục (Recovery Key) - lưu ở nơi an toàn. Xem lại bất cứ lúc nào ở tab <em>Recovery</em> (cần nhập mật khẩu).' },
          { title: 'Khoá nhanh', desc: 'Bấm biểu tượng ổ khoá trên thanh trên cùng hoặc nhấn <strong class="text-foreground">Ctrl+Shift+L</strong>.' },
          { title: 'Quên mật khẩu', desc: 'Ở màn hình khoá bấm <em>Quên mật khẩu?</em> → nhập Recovery Key → đặt mật khẩu mới.' },
          { title: 'Đổi hoặc tắt', desc: 'Tab <em>Đổi MK</em> để đổi mật khẩu; tab <em>Tắt khoá</em> (nhập mật khẩu) để tắt khoá màn hình.' },
        ]} />
        <WarningBox title="Khoá màn hình không mã hoá ổ đĩa">
          Khoá màn hình chỉ chặn người khác mở giao diện Deplao; file dữ liệu trên ổ đĩa không được mã hoá bằng mật khẩu này.
          Hãy đặt thêm mật khẩu đăng nhập Windows / macOS cho máy.
        </WarningBox>
      </Card>

      <Card>
        <SectionTitle><KeyIcon className="w-4 h-4 inline" /> Nhân viên, Public API &amp; ứng dụng: chỉ truy cập phần được cấp</SectionTitle>
        <BulletList items={[
          '<strong class="text-foreground">Nhân viên</strong> chỉ thấy và thao tác trên các tài khoản được giao, trong phạm vi quyền từng module (Cài đặt → Nhân viên).',
          '<strong class="text-foreground">Thu hồi ngay:</strong> vô hiệu hoá, xoá hoặc đổi mật khẩu một nhân viên là phiên đăng nhập của người đó hết hiệu lực. Nghi lộ tài khoản: bấm <em>Đăng xuất tất cả nhân viên</em> (Cài đặt → Nhân viên) - mọi máy nhân viên phải đăng nhập lại.',
          '<strong class="text-foreground">Public API tắt sẵn:</strong> chỉ hoạt động khi bạn bật server ở Công cụ → Ứng dụng, API &amp; Webhook → API và tự tạo API key. Mỗi key giới hạn theo quyền, tài khoản được dùng, IP được phép và hạn dùng; key chỉ hiện một lần lúc tạo, có nút <em>Thu hồi tất cả API key</em>.',
          '<strong class="text-foreground">Quyền "admin"</strong> của API key bao gồm mọi quyền khác (kể cả quản lý nhân viên và cài đặt) - chỉ cấp cho hệ thống bạn hoàn toàn tin tưởng.',
          '<strong class="text-foreground">Ứng dụng (plugin):</strong> bạn duyệt danh sách quyền trước khi cài; ứng dụng chỉ gọi được những thao tác đã duyệt, trên các tài khoản được cấp.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><CloudIcon className="w-4 h-4 inline" /> Đám mây là tuỳ chọn</SectionTitle>
        <Paragraph>
          Mặc định mọi dữ liệu nằm trên máy. <strong className="text-foreground">Cài đặt → Internet &amp; Đám mây</strong> (chỉ có trên máy chủ, không có ở máy nhân viên)
          chỉ hoạt động khi bạn tự kết nối.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-foreground">Dùng tài khoản của chính bạn:</strong> Cloudflare (địa chỉ Internet cố định, kho R2) hoặc Google Drive. Deplao chỉ tạo tunnel, tên miền con và bucket có tên deplao-…, không đụng tới dữ liệu sẵn có trên Cloudflare; token Cloudflare được lưu mã hoá trên máy.',
          '<strong class="text-foreground">Google Drive:</strong> đăng nhập Google trên trình duyệt; Deplao chỉ thấy các file do chính Deplao tạo trên Drive của bạn (thư mục "Deplao").',
          '<strong class="text-foreground">Bản sao lưu dữ liệu được mã hoá ngay trên máy</strong> bằng <em>Mật khẩu sao lưu</em> trước khi tải lên. Quên mật khẩu này thì máy khác không mở được bản sao lưu - hãy ghi lại cẩn thận.',
          '<strong class="text-foreground">Ảnh, video, file</strong> đồng bộ kèm được tải lên kho của bạn dưới dạng file gốc (không mã hoá) - hãy bảo vệ tài khoản Cloudflare / Google bằng mật khẩu mạnh và xác thực hai lớp.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><HardDriveIcon className="w-4 h-4 inline" /> Thư mục lưu trữ, dung lượng &amp; Workspace</SectionTitle>
        <WarningBox title="Windows: mặc định dữ liệu nằm ở ổ C - có thể đầy nhanh!">
          Mặc định toàn bộ tin nhắn, ảnh, video, file được lưu trong thư mục dữ liệu của ứng dụng (Windows:{' '}
          <code className={CODE_CLASS}>%AppData%\Deplao</code>). Với nhiều tài khoản và nhiều nhóm gửi ảnh, video, thư mục này có thể
          lên <strong className="text-foreground">vài GB đến hàng chục GB</strong> sau vài tháng; cài lại Windows cũng xoá sạch dữ liệu trên ổ C.
        </WarningBox>
        <BulletList items={[
          '<strong class="text-foreground">Đổi thư mục:</strong> Cài đặt → Lưu trữ → <em>Chọn thư mục khác</em> → chọn thư mục ở ổ D, E… hoặc ổ ngoài. Dữ liệu (kể cả ảnh, video, file) được sao chép sang và áp dụng ngay, không cần khởi động lại. Đừng đóng app khi đang sao chép.',
          '<strong class="text-foreground">Thư mục đã có dữ liệu Deplao:</strong> chọn <em>Dùng dữ liệu cũ tại đây</em> (chuyển sang dữ liệu sẵn có, dữ liệu hiện tại vẫn giữ ở chỗ cũ) hoặc <em>Sao chép dữ liệu hiện tại vào đây</em> (ghi đè dữ liệu cũ tại đó, không hoàn tác được).',
          '<strong class="text-foreground">Kiểm tra:</strong> trang Lưu trữ hiện <em>Thư mục cấu hình</em> và <em>File DB đang dùng</em>. Nếu báo <em>Phát hiện không khớp thư mục</em> (thường gặp sau khi cài lại), bấm <em>Chọn thư mục khác</em> và trỏ về đúng thư mục cũ để lấy lại dữ liệu. <em>Đặt lại mặc định</em> để quay về thư mục gốc.',
          '<strong class="text-foreground">Giảm dung lượng:</strong> bật <em>Tự động xoá media</em> cho từng tài khoản (Cài đặt → Tài khoản → biểu tượng bánh răng; xoá file cũ hơn số ngày đã đặt, chạy mỗi ngày lúc 3:00), hoặc lưu media lên Cloudflare R2 / Google Drive và chọn giải phóng ổ máy.',
          '<strong class="text-foreground">Workspace:</strong> mỗi workspace (Cài đặt → Workspace, tối đa 5) có dữ liệu, tài khoản và cài đặt riêng - <em>Local</em> cho máy Boss / dùng một mình, <em>Remote</em> để nhân viên kết nối tới máy Boss. Xoá một workspace Local là xoá vĩnh viễn dữ liệu của workspace đó.',
        ]} />
      </Card>

      <Card>
        <SectionTitle><CheckCircleIcon className="w-4 h-4 inline" /> Khuyến nghị</SectionTitle>
        <BulletList items={[
          'Đặt thư mục dữ liệu ở ổ riêng và sao lưu định kỳ: bật Đồng bộ dữ liệu lên đám mây, hoặc thoát hẳn app (chuột phải vào biểu tượng Deplao ở khay hệ thống → <em>Thoát hoàn toàn</em>) rồi copy cả thư mục dữ liệu sang ổ ngoài.',
          'Không chia sẻ thư mục dữ liệu hay file dữ liệu (.db) cho người khác - trong đó có tin nhắn, danh bạ và phiên đăng nhập của các tài khoản.',
          'Bật khoá màn hình nếu máy dùng chung; giữ kín API key, mật khẩu nhân viên và Mật khẩu sao lưu.',
          'Không dùng một tài khoản nữa: Cài đặt → Tài khoản → <em>Xóa</em> → chọn <em>Chỉ xoá tài khoản</em> (giữ dữ liệu trên máy) hoặc <em>Xoá tất cả dữ liệu</em> (xoá vĩnh viễn tin nhắn, danh bạ, CRM và media của tài khoản đó).',
          'Deplao là công cụ quản lý tài khoản của chính bạn: hãy tuân thủ điều khoản của Zalo, Facebook, Telegram và quy định về bảo vệ dữ liệu cá nhân; không dùng để gửi tin rác hay thu thập dữ liệu trái phép.',
        ]} />
      </Card>
    </div>
  );
}
