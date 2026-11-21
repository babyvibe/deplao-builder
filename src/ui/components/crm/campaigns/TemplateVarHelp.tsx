/**
 * "Chèn biến" help: the `?` button next to the variable chips explains where each value comes from —
 * the answer depends on the channel and on what the CRM / platform API actually has, which is not obvious
 * from the four chips (a Telegram contact has no Zalo gender, a phone number may exist only in the file…).
 *
 * `TemplateVarsHelpContent` is pure so the campaign render tests can assert the text without a DOM.
 */
import React, { useEffect } from 'react';
import { tr } from '../../../../shared/i18n';
import type { Channel } from '../../../../configs/channels/channelConfig';

const OK = '✓';
const NO = '—';

/** One short availability cell: ✓ + where it comes from, or — + why it is missing. */
interface Cell {
  mark: string;
  text: string;
}

function cell(available: boolean, text: string): Cell {
  return { mark: available ? OK : NO, text };
}

function CellView({ value }: { value: Cell }) {
  const available = value.mark === OK;
  return (
    <span className={`text-[10px] leading-4 ${available ? 'text-foreground/80' : 'text-subtle-foreground'}`}>
      <span className={`mr-1 font-bold ${available ? 'text-emerald-400' : 'text-muted-foreground'}`}>{value.mark}</span>
      {value.text}
    </span>
  );
}

export function TemplateVarsHelpContent({ channel, onClose }: { channel: string; onClose?: () => void }) {
  const zalo = channel === 'zalo';
  const channelLabel = channel === 'facebook'
    ? 'Facebook'
    : channel === 'telegram_user' || channel === 'telegram_bot' ? 'Telegram' : 'Zalo';

  /** Value availability per channel: the same variable is not equally filled on every channel. */
  const rows: Array<{ variable: string; meaning: string; zalo: Cell; telegram: Cell; facebook: Cell }> = [
    {
      variable: '{name}',
      meaning: tr('Tên người nhận'),
      zalo: cell(true, tr('tên trong danh sách hội thoại (hoặc tên gợi nhớ)')),
      telegram: cell(true, tr('tên liên hệ đã lưu')),
      facebook: cell(true, tr('tên hội thoại')),
    },
    {
      variable: '{userId}',
      meaning: tr('ID hội thoại của kênh'),
      zalo: cell(true, tr('UID Zalo')),
      telegram: cell(true, tr('chat id')),
      facebook: cell(true, tr('thread id')),
    },
    {
      variable: '{gender}',
      meaning: tr('Giới tính (Nam / Nữ)'),
      zalo: cell(true, tr('từ hồ sơ Zalo, đồng bộ về CRM')),
      telegram: cell(false, tr('CRM không tự có — chỉ điền khi bạn nhập tay')),
      facebook: cell(false, tr('CRM không tự có — chỉ điền khi bạn nhập tay')),
    },
    {
      variable: '{phone}',
      meaning: tr('Số điện thoại'),
      zalo: cell(true, tr('tệp → CRM → hồ sơ Zalo')),
      telegram: cell(true, tr('tệp → CRM')),
      facebook: cell(true, tr('tệp → CRM')),
    },
  ];

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{tr('Cách hoạt động của biến')}</p>
          <p className="text-[11px] leading-4 text-muted-foreground mt-0.5">
            {tr('Mỗi kênh và mỗi hồ sơ CRM có dữ liệu khác nhau. Bảng dưới đây là nguồn lấy giá trị khi gửi trên kênh đang chọn ({{channelLabel}}).', { channelLabel })}
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} title={tr('Đóng')} aria-label={tr('Đóng')}
            className="w-6 h-6 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-muted/50">
              <th className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground">{tr('Biến')}</th>
              <th className={`px-2 py-1.5 text-[10px] font-semibold ${zalo ? 'text-blue-300' : 'text-muted-foreground'}`}>Zalo</th>
              <th className={`px-2 py-1.5 text-[10px] font-semibold ${channel === 'telegram_user' || channel === 'telegram_bot' ? 'text-blue-300' : 'text-muted-foreground'}`}>Telegram</th>
              <th className={`px-2 py-1.5 text-[10px] font-semibold ${channel === 'facebook' ? 'text-blue-300' : 'text-muted-foreground'}`}>Facebook</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.variable} className="border-t border-border/60 align-top">
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <span className="block font-mono text-[11px] text-blue-400">{row.variable}</span>
                  <span className="block text-[10px] text-muted-foreground">{row.meaning}</span>
                </td>
                <td className="px-2 py-1.5"><CellView value={row.zalo} /></td>
                <td className="px-2 py-1.5"><CellView value={row.telegram} /></td>
                <td className="px-2 py-1.5"><CellView value={row.facebook} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1.5 text-[11px] leading-4 text-muted-foreground">
        <p>
          <span className="font-mono text-[11px] text-blue-400">{'{phone}'}</span>{' '}
          {tr('lấy theo thứ tự: (1) số trong danh sách người nhận bạn thêm (tệp hoặc "Theo SĐT"), (2) số trong hồ sơ CRM, (3) số trong hồ sơ Zalo nếu lần gửi đó đã gọi getUserInfo — không gọi thêm API.')}
        </p>
        <p>
          <span className="font-mono text-[11px] text-blue-400">{'{gender}'}</span>{' '}
          {tr('lấy từ trường Giới tính của liên hệ trong CRM; riêng Zalo trường này được đồng bộ từ hồ sơ Zalo. Telegram và Facebook cần nhập tay trong CRM mới có.')}
        </p>
        <p>
          <span className="font-mono text-[11px] text-blue-400">{'{userId}'}</span>{' '}
          {tr('là ID hội thoại, không phải số điện thoại. Người nhận thêm bằng SĐT trên Zalo được tra ra UID lúc gửi nên biến này là UID; muốn hiện số thì dùng {phone}.')}
        </p>
        <p className="text-subtle-foreground">
          {tr('Biến không có dữ liệu được thay bằng chuỗi rỗng (tin nhắn không hiện tên biến). Tên biến viết đúng như chip: chữ thường, trong ngoặc nhọn.')}
        </p>
        {!zalo && (
          <p className="text-yellow-400/80">
            {tr('Kênh {{channelLabel}} không có hồ sơ giới tính / SĐT từ nền tảng: giá trị chỉ đến từ tệp người nhận và CRM.', { channelLabel })}
          </p>
        )}
      </div>
    </div>
  );
}

/** `?` next to the "Chèn biến:" chips. Opens the explanation as a centred dialog so it is never clipped by the editor's scroll area. */
export default function TemplateVarHelp({ channel }: { channel: string }) {
  const [open, setOpen] = React.useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        title={tr('Giải thích cách hoạt động của biến')} aria-label={tr('Giải thích cách hoạt động của biến')}
        className="w-4 h-4 rounded-full border border-blue-500/40 text-blue-400 text-[10px] font-bold leading-none flex items-center justify-center hover:bg-blue-500/15 transition-colors flex-shrink-0">
        ?
      </button>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative w-[34rem] max-w-full max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
            role="dialog" aria-modal="true" aria-label={tr('Cách hoạt động của biến')}
            onClick={event => event.stopPropagation()}>
            <TemplateVarsHelpContent channel={channel} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Channel type re-export kept next to the help so callers do not import the config module for a prop type. */
export type TemplateVarHelpChannel = Channel;
