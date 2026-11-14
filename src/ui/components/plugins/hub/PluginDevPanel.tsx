/**
 * PluginDevPanel - the "Phát triển ứng dụng" (App development) drawer of the Apps, API & Webhook page: the steps to build a plugin, adding a folder under
 * development, installed dev plugins, links to the API/plugin docs and a quick SDK reference table.
 */
import React, { useState } from 'react';
import ipc, { PluginInfo } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { FolderIcon } from '@/components/common/icons';
import { Badge } from '@/components/settings/api/apiUi';
import PluginAvatar from './PluginAvatar';
import { STATUS } from './pluginUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const CLI = 'node packages/plugin-cli/bin/deplao-plugin.js';

export const DOC_LINKS: Array<{ hash: string; title: string; desc: string }> = [
  { hash: '#guide/plugins', title: tr('Ứng dụng: bắt đầu'), desc: tr('Tạo ứng dụng đầu tiên, cấu trúc thư mục, chạy thử, đóng gói.') },
  { hash: '#guide/plugin-reference', title: tr('Ứng dụng: tham chiếu'), desc: tr('Manifest, quyền, SDK deplao.*, backend, node workflow, route, lịch chạy.') },
  { hash: '#overview', title: tr('Toàn bộ API'), desc: tr('Mọi endpoint ứng dụng gọi được qua deplao.<nhóm>.<tên>(…), có thử gọi trực tiếp.') },
  { hash: '#guide/events', title: tr('Sự kiện realtime'), desc: tr('Tin nhắn mới, đổi trạng thái… nhận bằng deplao.events.on().') },
];

export const SDK_CHEATSHEET: Array<[string, string]> = [
  ['deplao.ready(cb)', tr('Chờ Deplao gửi ngữ cảnh, theme, cài đặt rồi mới chạy.')],
  ['deplao.chat.sendMessage({…})', tr('Gọi bất kỳ API v1 theo tên: deplao.<nhóm>.<operationId>(tham số).')],
  ['deplao.api.request(method, path, opts)', tr('Gọi API v1 theo đường dẫn (khi cần tự ghép URL).')],
  ['deplao.events.on(type, cb)', tr('Nhận sự kiện realtime (vd message.received).')],
  ['deplao.ui.context() / onContext(cb)', tr('Hội thoại đang mở — dùng trong panel chat.')],
  ['deplao.ui.toast / openConversation / insertComposerText / navigate', tr('Điều khiển giao diện Deplao.')],
  ['deplao.storage.get / set / list / delete', tr('Lưu dữ liệu riêng của ứng dụng (không đụng DB của Deplao).')],
  ['deplao.settings.get() / onChange(cb)', tr('Đọc cài đặt người dùng nhập ở trang Ứng dụng, API & Webhook.')],
  ['deplao.backend.call(name, params)', tr('Gọi lệnh trong backend của ứng dụng (commands).')],
  ['deplao.media.upload(file)', tr('Tải file lên để gửi kèm tin nhắn.')],
];

/** Open /docs at the right section in the browser (the API server turns itself on if it is off). */
export function openDocs(hash: string, notify: (msg: string, kind: 'error') => void) {
  if (!ipc.api) { notify(tr('Bản Deplao này chưa có module API'), 'error'); return; }
  ipc.api.openDocs(hash).then(res => { if (!res?.success) notify(res?.error || tr('Không mở được tài liệu'), 'error'); });
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
        {copied ? tr('Đã chép') : tr('Chép')}
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
          <p className="text-base font-semibold text-foreground">{tr('Tự làm ứng dụng — làm gì, công nghệ gì cũng được')}</p>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            {trx('Ứng dụng là một web app chạy ngay trong Deplao (HTML/CSS/JS thuần, React, Vue, Svelte…), giao diện hoàn toàn của bạn, gọi Deplao qua <0>deplao.*</0>. Cần xử lý nền thì thêm backend Node chạy trên máy, hoặc để server riêng của bạn xử lý.', { 0: <code className="text-foreground" /> })}
          </p>
          <p className="text-xs text-subtle-foreground mt-1.5 leading-relaxed">
            {trx('Trong mã nguồn, SDK và tài liệu, ứng dụng gọi là <0>plugin</0>: file <1>deplao-plugin.json</1>, gói <2>@deplao/plugin-sdk</2>, lệnh <3>deplao-plugin</3>.', { 0: <i />, 1: <code className="text-foreground" />, 2: <code className="text-foreground" />, 3: <code className="text-foreground" /> })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={onAddDevFolder} className="px-3 py-2 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground text-sm font-medium disabled:opacity-50">
            {trx('<0/>Thêm thư mục đang phát triển', { 0: <FolderIcon className="w-4 h-4 inline mr-1.5" /> })}
          </button>
          <button type="button" onClick={() => docs('#guide/plugins')} className="px-3 py-2 rounded-lg bg-muted hover:bg-accent text-foreground text-sm">
            {tr('Mở hướng dẫn')}
          </button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <p className="text-sm font-semibold text-foreground">{tr('4 bước làm ứng dụng')}</p>
          <ol className="space-y-3">
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80">{trx('<0>1.</0> Tạo khung ứng dụng (web, local hoặc remote):', { 0: <span className="text-primary font-semibold" /> })}</p>
              <Command text={`${CLI} create my-plugin --runtime web --id vn.acme.myplugin --name "My Plugin"`} />
            </li>
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80">{trx('<0>2.</0> Bấm <1>Thêm thư mục đang phát triển</1>, chọn thư mục có <2>deplao-plugin.json</2>. Ứng dụng chạy tại chỗ: sửa code xong bấm <3>Tải lại</3> trong chi tiết ứng dụng.', { 0: <span className="text-primary font-semibold" />, 1: <b />, 2: <code />, 3: <b /> })}</p>
            </li>
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80">{trx('<0>3.</0> Kiểm tra manifest trước khi gửi:', { 0: <span className="text-primary font-semibold" /> })}</p>
              <Command text={`${CLI} validate my-plugin`} />
            </li>
            <li className="space-y-1.5">
              <p className="text-xs text-foreground/80">{trx('<0>4.</0> Đóng gói thành file .zip để khách cài ở trang này:', { 0: <span className="text-primary font-semibold" /> })}</p>
              <Command text={`${CLI} pack my-plugin`} />
            </li>
          </ol>
          <p className="text-[11px] text-subtle-foreground leading-relaxed">
            {trx('Ứng dụng mẫu trong mã nguồn (<0>examples/plugins</0>): <1>hello-world</1> (chỉ giao diện), <2>spa-booking</2> (backend, panel chat, workflow, lịch chạy), <3>order-sync-remote</3> (server ngoài).', { 0: <code />, 1: <b />, 2: <b />, 3: <b /> })}
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
          <p className="text-sm font-semibold text-foreground">{tr('Tài liệu')}</p>
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
          <p className="text-[11px] text-subtle-foreground">{tr('Tài liệu mở trong trình duyệt từ API server trên máy (tự bật nếu đang tắt).')}</p>
          <div className="space-y-1 pt-1">
            <p className="text-xs font-semibold text-foreground/80">{tr('Giao diện: tự do')}</p>
            <p className="text-[11px] text-subtle-foreground leading-relaxed">
              {trx('CSS và framework là của ứng dụng: CSS thuần, Tailwind, React, Vue, Svelte… Chỉ cần build ra file tĩnh và đóng gói kèm (script, CSS, font từ CDN bị chặn để bảo mật). Muốn hợp theme sáng/tối của Deplao thì đọc <0>deplao.ui.theme()</0> hoặc dùng biến CSS <1>--dp-bg</1>, <2>--dp-text</2>, <3>--dp-accent</3>… — tuỳ bạn.', { 0: <code />, 1: <code />, 2: <code />, 3: <code /> })}
            </p>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">{tr('Ứng dụng đang phát triển')}</p>
          <span className="text-[11px] text-subtle-foreground">{trx('{{count}} thư mục', { count: devPlugins.length })}</span>
        </div>
        {devPlugins.length === 0 ? (
          <p className="text-xs text-subtle-foreground">{tr('Chưa có. Bấm "Thêm thư mục đang phát triển" để chạy ứng dụng ngay từ thư mục code của bạn.')}</p>
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
        <p className="text-sm font-semibold text-foreground">{trx('Tra nhanh SDK <0>/__deplao/sdk.js</0>', { 0: <code className="text-xs text-muted-foreground font-normal" /> })}</p>
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
