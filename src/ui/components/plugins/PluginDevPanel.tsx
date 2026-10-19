/**
 * PluginDevPanel — ngăn "Phát triển ứng dụng" của trang Ứng dụng, API & Webhook: các bước làm ứng dụng (plugin), thêm thư mục đang
 * phát triển, plugin dev đang cài, link tài liệu API/plugin và bảng tra nhanh SDK.
 */
import React, { useState } from 'react';
import ipc, { PluginInfo } from '@/lib/ipc';
import { useAppStore } from '@/store/appStore';
import { FolderIcon } from '@/components/common/icons';
import { Badge } from '@/components/settings/api/apiUi';
import PluginAvatar from './PluginAvatar';
import { STATUS } from './pluginUi';

const CLI = 'node packages/plugin-cli/bin/deplao-plugin.js';

export const DOC_LINKS: Array<{ hash: string; title: string; desc: string }> = [
  { hash: '#guide/plugins', title: 'Ứng dụng: bắt đầu', desc: 'Tạo ứng dụng đầu tiên, cấu trúc thư mục, chạy thử, đóng gói.' },
  { hash: '#guide/plugin-reference', title: 'Ứng dụng: tham chiếu', desc: 'Manifest, quyền, SDK deplao.*, backend, node workflow, route, lịch chạy.' },
  { hash: '#overview', title: 'Toàn bộ API', desc: 'Mọi endpoint ứng dụng gọi được qua deplao.<nhóm>.<tên>(…), có thử gọi trực tiếp.' },
  { hash: '#guide/events', title: 'Sự kiện realtime', desc: 'Tin nhắn mới, đổi trạng thái… nhận bằng deplao.events.on().' },
];

export const SDK_CHEATSHEET: Array<[string, string]> = [
  ['deplao.ready(cb)', 'Chờ Deplao gửi ngữ cảnh, theme, cài đặt rồi mới chạy.'],
  ['deplao.chat.sendMessage({…})', 'Gọi bất kỳ API v1 theo tên: deplao.<nhóm>.<operationId>(tham số).'],
  ['deplao.api.request(method, path, opts)', 'Gọi API v1 theo đường dẫn (khi cần tự ghép URL).'],
  ['deplao.events.on(type, cb)', 'Nhận sự kiện realtime (vd message.received).'],
  ['deplao.ui.context() / onContext(cb)', 'Hội thoại đang mở — dùng trong panel chat.'],
  ['deplao.ui.toast / openConversation / insertComposerText / navigate', 'Điều khiển giao diện Deplao.'],
  ['deplao.storage.get / set / list / delete', 'Lưu dữ liệu riêng của ứng dụng (không đụng DB của Deplao).'],
  ['deplao.settings.get() / onChange(cb)', 'Đọc cài đặt người dùng nhập ở trang Ứng dụng, API & Webhook.'],
  ['deplao.backend.call(name, params)', 'Gọi lệnh trong backend của ứng dụng (commands).'],
  ['deplao.media.upload(file)', 'Tải file lên để gửi kèm tin nhắn.'],
];

/** Mở /docs đúng mục trong trình duyệt (API server tự bật nếu đang tắt). */
export function openDocs(hash: string, notify: (msg: string, kind: 'error') => void) {
  if (!ipc.api) { notify('Bản Deplao này chưa có module API', 'error'); return; }
  ipc.api.openDocs(hash).then(res => { if (!res?.success) notify(res?.error || 'Không mở được tài liệu', 'error'); });
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 bg-card border border-border rounded-lg pl-3 pr-1 py-1">
      <code className="flex-1 text-[11px] text-foreground font-mono break-all">{text}</code>
      <button
        type="button"
        onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
        className="px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground flex-shrink-0"
      >
        {copied ? 'Đã chép' : 'Chép'}
      </button>
    </div>
  );
}

export default function PluginDevPanel({ plugins, busy, onAddDevFolder, onOpenDetail }: {
  plugins: PluginInfo[];
  busy: boolean;
  onAddDevFolder: () => void;
  onOpenDetail: (p: PluginInfo) => void;
}) {
  const showNotification = useAppStore(s => s.showNotification);
  const devPlugins = plugins.filter(p => p.source_type === 'dev');
  const docs = (hash: string) => openDocs(hash, showNotification);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-border bg-card p-5 flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-[260px]">
          <p className="text-base font-semibold text-foreground">Tự làm ứng dụng — làm gì, công nghệ gì cũng được</p>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            Ứng dụng là một web app chạy ngay trong Deplao (HTML/CSS/JS thuần, React, Vue, Svelte…), giao diện hoàn toàn của bạn,
            gọi Deplao qua <code className="text-foreground">deplao.*</code>. Cần xử lý nền thì thêm backend Node chạy trên máy, hoặc để server riêng của bạn xử lý.
          </p>
          <p className="text-xs text-subtle-foreground mt-1.5 leading-relaxed">
            Trong mã nguồn, SDK và tài liệu, ứng dụng gọi là <i>plugin</i>: file <code className="text-foreground">deplao-plugin.json</code>,
            gói <code className="text-foreground">@deplao/plugin-sdk</code>, lệnh <code className="text-foreground">deplao-plugin</code>.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={onAddDevFolder} className="px-3 py-2 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium disabled:opacity-50">
            <FolderIcon className="w-4 h-4 inline mr-1.5" />Thêm thư mục đang phát triển
          </button>
          <button type="button" onClick={() => docs('#guide/plugins')} className="px-3 py-2 rounded-lg bg-muted hover:bg-accent text-foreground text-sm">
            Mở hướng dẫn
          </button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <p className="text-sm font-semibold text-foreground">4 bước làm ứng dụng</p>
          <ol className="space-y-3">
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80"><span className="text-primary font-semibold">1.</span> Tạo khung ứng dụng (web, local hoặc remote):</p>
              <Command text={`${CLI} create my-plugin --runtime web --id vn.acme.myplugin --name "My Plugin"`} />
            </li>
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80"><span className="text-primary font-semibold">2.</span> Bấm <b>Thêm thư mục đang phát triển</b>, chọn thư mục có <code>deplao-plugin.json</code>. Ứng dụng chạy tại chỗ: sửa code xong bấm <b>Tải lại</b> trong chi tiết ứng dụng.</p>
            </li>
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80"><span className="text-primary font-semibold">3.</span> Kiểm tra manifest trước khi gửi:</p>
              <Command text={`${CLI} validate my-plugin`} />
            </li>
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80"><span className="text-primary font-semibold">4.</span> Đóng gói thành file .zip để khách cài ở trang này:</p>
              <Command text={`${CLI} pack my-plugin`} />
            </li>
          </ol>
          <p className="text-[11px] text-subtle-foreground leading-relaxed">
            Ứng dụng mẫu trong mã nguồn (<code>examples/plugins</code>): <b>hello-world</b> (chỉ giao diện), <b>spa-booking</b> (backend, panel chat, workflow, lịch chạy), <b>order-sync-remote</b> (server ngoài).
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
          <p className="text-sm font-semibold text-foreground">Tài liệu</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {DOC_LINKS.map(d => (
              <button
                key={d.hash}
                type="button"
                onClick={() => docs(d.hash)}
                className="text-left rounded-xl border border-border bg-card hover:border-primary/60 px-3 py-2.5 transition-colors"
              >
                <p className="text-sm font-medium text-primary">{d.title} ↗</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{d.desc}</p>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-subtle-foreground">Tài liệu mở trong trình duyệt từ API server trên máy (tự bật nếu đang tắt).</p>
          <div className="space-y-1 pt-1">
            <p className="text-xs font-semibold text-foreground/80">Giao diện: tự do</p>
            <p className="text-[11px] text-subtle-foreground leading-relaxed">
              CSS và framework là của ứng dụng: CSS thuần, Tailwind, React, Vue, Svelte… Chỉ cần build ra file tĩnh và đóng gói kèm
              (script, CSS, font từ CDN bị chặn để bảo mật). Muốn hợp theme sáng/tối của Deplao thì đọc <code>deplao.ui.theme()</code> hoặc
              dùng biến CSS <code>--dp-bg</code>, <code>--dp-text</code>, <code>--dp-accent</code>… — tuỳ bạn.
            </p>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">Ứng dụng đang phát triển</p>
          <span className="text-[11px] text-subtle-foreground">{devPlugins.length} thư mục</span>
        </div>
        {devPlugins.length === 0 ? (
          <p className="text-xs text-subtle-foreground">Chưa có. Bấm "Thêm thư mục đang phát triển" để chạy ứng dụng ngay từ thư mục code của bạn.</p>
        ) : (
          <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {devPlugins.map(p => {
              const st = STATUS[p.status] || STATUS.disabled;
              return (
                <button key={p.id} type="button" onClick={() => onOpenDetail(p)} className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50">
                  <PluginAvatar id={p.id} name={p.name} icon={p.icon} size={32} rounded={9} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{p.name} <span className="text-[11px] text-subtle-foreground">v{p.version}</span></p>
                    <p className="text-[11px] text-subtle-foreground font-mono truncate">{p.install_path}</p>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <p className="text-sm font-semibold text-foreground">Tra nhanh SDK <code className="text-xs text-muted-foreground font-normal">/__deplao/sdk.js</code></p>
        <div className="rounded-xl border border-border overflow-hidden">
          {SDK_CHEATSHEET.map(([code, desc]) => (
            <div key={code} className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-3 px-3 py-2 border-t border-border first:border-t-0">
              <code className="text-[11px] text-primary font-mono break-all">{code}</code>
              <span className="text-[11px] text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
