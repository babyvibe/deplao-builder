import React from 'react';
import ipc from '@/lib/ipc';
import qrCodeImg from '../../../../assets/donate/qr.png';
import { BookIcon, BotIcon, BugIcon, ChartIcon, CoffeeIcon, FolderIcon, GlobeIcon, PhoneIcon, PluginIcon, SendIcon, SmartphoneIcon, WrenchIcon } from '@/components/common/icons';
import { Card, Paragraph, SectionTitle } from './introUi';

export function DonateCoffeePanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-3xl leading-none"><CoffeeIcon className="w-8 h-8" /></span>
        <div>
          <h3 className="text-foreground font-bold text-base">Donate & Ủng hộ</h3>
          <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">
            Dự án phát triển bởi <strong className="text-foreground">Deplao</strong> với mục tiêu mang công cụ all-in-one tất cả mọi thứ người dùng cần để quản lý và marketing
            trên Zalo, Facebook, Telegram đến mọi cá nhân và doanh nghiệp nhỏ hoàn toàn <strong className="text-success">miễn phí</strong>.
            Mỗi ly cà phê của bạn giúp tụi mình có thêm token AI, duy trì server và phát triển tính năng mới.
          </p>
        </div>
      </div>

      <Card>
        <SectionTitle><SmartphoneIcon className="w-4 h-4 inline" /> Quét mã QR - Ủng hộ qua chuyển khoản</SectionTitle>
        <Paragraph>
          Quét mã QR bên dưới bằng app ngân hàng để ủng hộ đội ngũ phát triển.
          Mọi đóng góp đều được ghi nhận và biết ơn!
        </Paragraph>
        <div className="flex justify-center mt-3">
          <img
            src={qrCodeImg}
            alt="Mã QR chuyển khoản ủng hộ Deplao"
            className="w-60 rounded-2xl border border-border object-contain select-none"
          />
        </div>
      </Card>

      {/* Nhận Job */}
      <Card>
        <SectionTitle><FolderIcon className="w-4 h-4 inline" /> Nhận dự án - Team nhận làm phần mềm theo yêu cầu</SectionTitle>
        <Paragraph>
          Ngoài Deplao, team còn nhận phát triển phần mềm theo yêu cầu riêng (custom software development).
          Nếu bạn cần một công cụ quản lý, tự động hoá hoặc bất cứ giải pháp công nghệ nào, đừng ngần ngại liên hệ!
        </Paragraph>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
          {[
            { icon: <WrenchIcon className="w-4 h-4" />, title: 'Phần mềm desktop', desc: 'Ứng dụng Electron, React, TypeScript cho Windows/macOS' },
            { icon: <GlobeIcon className="w-4 h-4" />, title: 'Web app & API', desc: 'Backend Node.js, React, PHP,... database quản lý doanh nghiệp' },
            { icon: <BotIcon className="w-4 h-4" />, title: 'Tự động hoá & Bot', desc: 'Zalo bot, Facebook bot, Telegram bot, workflow automation' },
            { icon: <ChartIcon className="w-4 h-4" />, title: 'CRM & ERP', desc: 'Hệ thống quản lý khách hàng, nhân viên, bán hàng riêng' },
            { icon: <PluginIcon className="w-4 h-4" />, title: 'Tích hợp API', desc: 'Kết nối POS, thanh toán, vận chuyển, webhook, third-party' },
            { icon: <SmartphoneIcon className="w-4 h-4" />, title: 'AI & Chatbot', desc: 'Tích hợp GPT, Gemini, xử lý ngôn ngữ tự nhiên, phân loại' },
          ].map((item, i) => (
            <div key={i} className="bg-muted rounded-lg p-2.5 border border-input/30">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-sm">{item.icon}</span>
                <p className="text-[11px] font-semibold text-foreground">{item.title}</p>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Contact */}
      <Card>
        <SectionTitle><PhoneIcon className="w-4 h-4 inline" /> Liên hệ team</SectionTitle>
        <div className="space-y-2">
          <div className="flex items-center gap-2.5 bg-muted rounded-lg px-3 py-2.5">
            <span className="text-muted-foreground"><BugIcon className="w-4 h-4" /></span>
            <div>
              <p className="text-xs text-foreground font-medium">GitHub Issues - báo lỗi, góp ý</p>
              <button
                onClick={() => ipc.shell?.openExternal('https://github.com/babyvibe/deplao-builder/issues')}
                className="text-[11px] text-primary hover:underline transition-colors text-left"
              >
                github.com/babyvibe/deplao-builder/issues
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2.5 bg-muted rounded-lg px-3 py-2.5">
            <span className="text-muted-foreground"><SendIcon className="w-4 h-4" /></span>
            <div>
              <p className="text-xs text-foreground font-medium">Telegram</p>
              <button
                onClick={() => ipc.shell?.openExternal('https://t.me/babyvibe9')}
                className="text-[11px] text-primary hover:underline transition-colors text-left"
              >
                t.me/babyvibe9
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2.5 bg-muted rounded-lg px-3 py-2.5">
            <span className="text-muted-foreground"><BookIcon className="w-4 h-4" /></span>
            <div>
              <p className="text-xs text-foreground font-medium">Facebook</p>
              <button
                onClick={() => ipc.shell?.openExternal('https://fb.com/tientt99')}
                className="text-[11px] text-primary hover:underline transition-colors text-left"
              >
                fb.com/tientt99
              </button>
            </div>
          </div>
          <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
            <p className="text-xs text-warning font-medium text-center">
              <CoffeeIcon className="w-4 h-4 inline" /> Cảm ơn bạn đã quan tâm và ủng hộ! Mỗi đóng góp đều giúp dự án phát triển tốt hơn.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
