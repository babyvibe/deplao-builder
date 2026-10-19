# Deplao UI kit — tokens + base components

Mục tiêu: mọi màn dùng chung **một bảng màu ngữ nghĩa** (đổi theme chỉ đổi biến CSS) và
**một bộ component cơ bản**. Không viết `bg-gray-800`, `text-white`, mã hex trong component mới.

## 1. Token màu (Tailwind class → biến CSS trong `src/ui/index.css`)

| Vai trò | Class | Dùng cho |
| --- | --- | --- |
| Nền app | `bg-background` | khung app, vùng nội dung |
| Panel / card / dòng danh sách | `bg-card` | card, panel, hàng trong list |
| Menu / dialog | `bg-popover` | dropdown, dialog, popup |
| Ô nhập, fill nhẹ, hover dòng | `bg-muted` | input bg, hover row, badge nền |
| Fill đậm hơn / đang chọn | `bg-accent` | active row, nút secondary hover |
| Viền thường | `border-border` (hoặc chỉ `border`) | mọi đường kẻ |
| Viền ô nhập | `border-input` | input, select, textarea |
| Viền đậm | `border-border-strong` | hover/focus viền, chia vùng rõ |
| Chữ chính | `text-foreground` | tiêu đề, nội dung |
| Chữ phụ | `text-muted-foreground` | mô tả, nhãn |
| Chữ mờ | `text-subtle-foreground` | thời gian, placeholder, đếm |
| Màu nhấn | `bg-primary text-primary-foreground`, `hover:bg-primary-hover`, `text-primary` | nút chính, link, trạng thái chọn |
| Nguy hiểm | `bg-destructive text-destructive-foreground`, `text-destructive` | xoá, lỗi |
| Trạng thái | `text-success` / `text-warning` / `text-info` (+ `bg-success/10` …) | badge, icon trạng thái |
| Focus ring | `ring-ring` (hoặc chỉ `ring-2`) | focus-visible |
| Sidebar (rail) | `bg-sidebar`, `hover:bg-sidebar-hover`, đang chọn `bg-sidebar-active text-sidebar-active-foreground`, icon/chữ nghỉ `text-sidebar-foreground/70` | rail trái: theme sáng nền xanh xám nhạt, ô chọn xanh đặc |
| Bong bóng tin nhắn | `bg-bubble-in border-bubble-in-border` (nhận) / `bg-bubble-out border-bubble-out-border` (gửi), `rounded-lg`, giờ nhỏ trong bong bóng | chat: trắng / #e4effd, viền #e3e6eb / #c5dcfa ở theme sáng |
| Pill thời gian / hệ thống | `bg-black/20 text-white dark:bg-white/15` | "Hôm nay", 23:34 giữa khung chat |
| Dòng đang chọn | `bg-selected hover:bg-selected` (hover thường: `hover:bg-muted`) | hội thoại đang mở, item đang chọn trong list |

Mọi token hỗ trợ opacity: `bg-primary/10`, `bg-foreground/5` (overlay mờ đúng ở cả hai theme),
`border-border/50`. **Overlay backdrop** dùng `bg-black/60` (giữ nguyên ở hai theme).

Quy đổi từ class cũ (codemod `scripts/ui-codemod-tokens.js`):

| Cũ | Mới |
| --- | --- |
| `bg-gray-950`, `bg-gray-900` | `bg-background` |
| `bg-gray-800` | `bg-card` |
| `bg-gray-750`, `bg-gray-700` | `bg-muted` |
| `bg-gray-600`, `bg-gray-500` | `bg-accent` |
| `text-white`, `text-gray-50/100/200` | `text-foreground` (giữ `text-white` khi cùng chuỗi class có nền màu: `bg-blue-600`, `bg-red-500`, gradient…) |
| `text-gray-300` | `text-foreground/80` |
| `text-gray-400` | `text-muted-foreground` |
| `text-gray-500`, `text-gray-600` | `text-subtle-foreground` |
| `placeholder-gray-500/600` | `placeholder-subtle-foreground` |
| `border-gray-800/700`, `divide-gray-*`, `ring-gray-700` | `border-border`, `divide-border`, `ring-border` |
| `border-gray-600` | `border-input` |
| `border-gray-500/400` | `border-border-strong` |
| `bg-white/N`, `text-white/N`, `border-white/N` (N ≤ 30) | `bg-foreground/N` … |

Hậu tố opacity và tiền tố biến thể (`hover:`, `group-hover:`, `focus:`, `disabled:`…) giữ nguyên.
Class có tiền tố `dark:` không đổi.

## 2. Bộ component cơ bản (`src/ui/components/ui/`)

Tất cả: `forwardRef`, nhận `className` (gộp bằng `cn()` từ `@/lib/cn`), kế thừa props HTML tương ứng,
`focus-visible:ring-2 ring-ring ring-offset-2 ring-offset-background`, `disabled:opacity-50 disabled:pointer-events-none`,
chữ `text-sm`, bo góc `rounded-lg`, chiều cao control 36px (`h-9`), `sm` = 32px (`h-8`), `lg` = 40px (`h-10`).
Không hard-code màu, không `dark:`. Icon lấy từ `@/components/common/icons` (138 icon, `className="w-4 h-4"`).

| File | Export | Props chính |
| --- | --- | --- |
| `button.tsx` | `Button` | `variant`: `primary` (mặc định) · `secondary` (bg-muted) · `outline` · `ghost` · `destructive` · `link`; `size`: `sm` · `md` · `lg` · `icon` (vuông 36px); `loading?: boolean` (spinner, disabled); `leftIcon?`, `rightIcon?: ReactNode` |
| `input.tsx` | `Input`, `Textarea` | HTML props; `invalid?: boolean` (viền destructive); `Textarea` có `autoResize?` không bắt buộc |
| `select.tsx` | `Select` | `<select>` native, children là `<option>`; chevron bên phải; `invalid?` |
| `checkbox.tsx` | `Checkbox`, `Switch` | `checked`, `onCheckedChange(checked: boolean)`, `label?: ReactNode`, `description?`, `disabled?`; `Switch` thêm `size?: 'sm' \| 'md'` |
| `badge.tsx` | `Badge` | `variant`: `default` (bg-muted) · `primary` · `success` · `warning` · `destructive` · `info` · `outline`; `dot?: boolean` (chấm tròn trước chữ); nền màu dùng `bg-success/15 text-success` kiểu nhạt, không nền đặc |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | `Card`: `bg-card border border-border rounded-xl`; `padding?: 'none' \| 'sm' \| 'md'` trên CardContent |
| `label.tsx` | `Label`, `FormField` | `FormField({ label, hint?, error?, required?, htmlFor?, children })` xếp dọc: label, control, hint/error |
| `empty-state.tsx` | `EmptyState` | `icon?: ReactNode`, `title`, `description?`, `action?: ReactNode`; căn giữa, icon trong vòng `bg-muted` |
| `dialog.tsx` | `Dialog`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogBody`, `DialogFooter`, `DialogClose` | `Dialog({ open, onOpenChange(open: boolean), size?: 'sm' \| 'md' \| 'lg' \| 'xl' \| 'full', closeOnOverlay?: true, children })`: portal vào `document.body`, backdrop `bg-black/60`, Escape đóng, click backdrop đóng, khoá scroll body, focus vào dialog khi mở, trả focus khi đóng, animation `popupIn` có sẵn trong index.css. `DialogClose` = nút X góc phải |
| `dropdown-menu.tsx` | `DropdownMenu`, `DropdownMenuItem`, `DropdownMenuSeparator`, `DropdownMenuLabel` | `DropdownMenu({ trigger: ReactNode, align?: 'start' \| 'end', side?: 'bottom' \| 'top', children })`: mở/đóng bằng click trigger, đóng khi click ngoài / Escape / chọn item, portal + định vị theo `getBoundingClientRect`, lật lên khi thiếu chỗ dưới; phím ↑↓ Enter di chuyển item. `DropdownMenuItem({ onSelect, icon?, destructive?, disabled?, shortcut? })` |
| `tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `Tabs({ value, onValueChange, variant?: 'underline' \| 'pills' })` qua context; `TabsTrigger({ value, icon?, count? })`; `TabsContent({ value })` chỉ render khi active |
| `tooltip.tsx` | `Tooltip` | `Tooltip({ content, side?: 'top' \| 'bottom' \| 'left' \| 'right', delay?: 300, children })`: hiện khi hover/focus, portal, `bg-popover border text-xs shadow` |
| `index.ts` | barrel re-export tất cả | |

Trang mẫu để duyệt: Settings → Giao diện → mục "Hệ thống giao diện" (`DesignSystemPage.tsx`), hiện mọi
component ở các trạng thái, đổi theme bằng nút có sẵn trên TopBar.
