/**
 * DesignSystemPage — trang mẫu để duyệt token màu + bộ component cơ bản ở cả hai theme.
 * Không phụ thuộc store/electronAPI; mount trong Settings → Giao diện (dev) và harness ds-preview.
 */
import React, { useState } from 'react';
import { cn } from '@/lib/cn';
import {
  PlusIcon, TrashIcon, EditIcon, SearchIcon, SendIcon, InboxIcon, SettingsIcon, UserIcon,
  CopyIcon, DownloadIcon, MessageIcon, UsersIcon, BellIcon, RefreshIcon, ChevronDownIcon,
  CheckCircleIcon, AlertIcon, InfoIcon, ExternalLinkIcon, FilterIcon,
} from '@/components/common/icons';
import { Button } from './button';
import { Input, Textarea } from './input';
import { Select } from './select';
import { Checkbox, Switch } from './checkbox';
import { Badge } from './badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card';
import { Label, FormField } from './label';
import { EmptyState } from './empty-state';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, DialogClose } from './dialog';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel } from './dropdown-menu';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
import { Tooltip } from './tooltip';

// ─── helpers ─────────────────────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Swatch({ cls, name, note, border }: { cls: string; name: string; note?: string; border?: boolean }) {
  return (
    <div className="min-w-0">
      <div className={cn('h-12 rounded-lg', border ? 'border-2' : 'border border-border', cls)} />
      <div className="mt-1.5 truncate text-xs font-medium text-foreground">{name}</div>
      <div className="truncate font-mono text-[11px] text-subtle-foreground">{note ?? cls}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-subtle-foreground">{label}</span>
      {children}
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

export function DesignSystemPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formDialogOpen, setFormDialogOpen] = useState(false);
  const [tab, setTab] = useState('all');
  const [pillTab, setPillTab] = useState('day');
  const [notify, setNotify] = useState(true);
  const [sound, setSound] = useState(false);
  const [agree, setAgree] = useState(true);
  const [channel, setChannel] = useState('zalo');

  return (
    <div className="space-y-10 text-foreground">
      {/* ── Tokens ── */}
      <Section title="Màu nền và bề mặt" description="Lớp sau đặt trên lớp trước: background → card → popover. muted/accent cho ô nhập, hover, đang chọn.">
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-5">
          <Swatch cls="bg-background" name="background" />
          <Swatch cls="bg-card" name="card" />
          <Swatch cls="bg-popover" name="popover" />
          <Swatch cls="bg-muted" name="muted" />
          <Swatch cls="bg-accent" name="accent" />
        </div>
      </Section>

      <Section title="Đường kẻ">
        <div className="grid grid-cols-3 gap-4">
          <Swatch cls="border-border bg-card" name="border" border />
          <Swatch cls="border-input bg-card" name="input" border />
          <Swatch cls="border-border-strong bg-card" name="border-strong" border />
        </div>
      </Section>

      <Section title="Chữ">
        <Card>
          <CardContent className="space-y-1.5">
            <p className="text-base font-semibold text-foreground">Tiêu đề · text-foreground font-semibold</p>
            <p className="text-sm text-foreground">Nội dung chính · text-sm text-foreground</p>
            <p className="text-sm text-foreground/80">Nội dung phụ nhẹ · text-foreground/80</p>
            <p className="text-sm text-muted-foreground">Mô tả, nhãn · text-muted-foreground</p>
            <p className="text-xs text-subtle-foreground">Thời gian, placeholder, số đếm · text-xs text-subtle-foreground</p>
            <p className="text-sm text-primary">Link, đang chọn · text-primary</p>
          </CardContent>
        </Card>
      </Section>

      <Section title="Màu nhấn và trạng thái" description="Nền đặc chỉ cho nút chính. Trạng thái dùng nền nhạt /15 + chữ màu.">
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-5">
          <Swatch cls="bg-primary" name="primary" />
          <Swatch cls="bg-destructive" name="destructive" />
          <Swatch cls="bg-success" name="success" />
          <Swatch cls="bg-warning" name="warning" />
          <Swatch cls="bg-info" name="info" />
          <Swatch cls="bg-primary/15" name="primary /15" note="bg-primary/15" />
          <Swatch cls="bg-destructive/15" name="destructive /15" note="bg-destructive/15" />
          <Swatch cls="bg-success/15" name="success /15" note="bg-success/15" />
          <Swatch cls="bg-warning/15" name="warning /15" note="bg-warning/15" />
          <Swatch cls="bg-info/15" name="info /15" note="bg-info/15" />
        </div>
      </Section>

      {/* ── Buttons ── */}
      <Section title="Button" description="6 biến thể × 4 cỡ. Một nút chính mỗi vùng; còn lại secondary/outline/ghost.">
        <Card>
          <CardContent className="space-y-4">
            <Row label="variant">
              <Button>Lưu thay đổi</Button>
              <Button variant="secondary">Huỷ</Button>
              <Button variant="outline">Xuất file</Button>
              <Button variant="ghost">Bỏ qua</Button>
              <Button variant="destructive">Xoá</Button>
              <Button variant="link">Xem chi tiết</Button>
            </Row>
            <Row label="size">
              <Button size="sm">Nhỏ</Button>
              <Button size="md">Vừa</Button>
              <Button size="lg">Lớn</Button>
              <Button size="icon" aria-label="Thêm"><PlusIcon className="h-4 w-4" /></Button>
              <Button size="icon" variant="outline" aria-label="Cài đặt"><SettingsIcon className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" aria-label="Xoá"><TrashIcon className="h-4 w-4" /></Button>
            </Row>
            <Row label="icon">
              <Button leftIcon={<PlusIcon className="h-4 w-4" />}>Thêm tài khoản</Button>
              <Button variant="secondary" leftIcon={<DownloadIcon className="h-4 w-4" />}>Tải xuống</Button>
              <Button variant="outline" rightIcon={<ExternalLinkIcon className="h-4 w-4" />}>Mở Zalo</Button>
              <Button variant="ghost" leftIcon={<RefreshIcon className="h-4 w-4" />}>Làm mới</Button>
            </Row>
            <Row label="state">
              <Button loading>Đang lưu</Button>
              <Button variant="secondary" loading>Đang tải</Button>
              <Button disabled>Vô hiệu</Button>
              <Button variant="outline" disabled>Vô hiệu</Button>
              <Button variant="destructive" loading>Đang xoá</Button>
            </Row>
          </CardContent>
        </Card>
      </Section>

      {/* ── Form controls ── */}
      <Section title="Form" description="Ô nhập cao 36px, nền muted, viền input. Lỗi đổi viền sang destructive và hiện dòng lỗi.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Thông tin tài khoản</CardTitle>
              <CardDescription>FormField xếp dọc: nhãn, control, gợi ý hoặc lỗi.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField label="Tên hiển thị" required hint="Tên này hiện với khách hàng.">
                <Input placeholder="VD: Deplao Support" defaultValue="Deplao Support" />
              </FormField>
              <FormField label="Số điện thoại" error="Số điện thoại không hợp lệ.">
                <Input invalid defaultValue="09xx" />
              </FormField>
              <FormField label="Kênh mặc định">
                <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="zalo">Zalo</option>
                  <option value="facebook">Facebook</option>
                  <option value="telegram">Telegram</option>
                </Select>
              </FormField>
              <FormField label="Ghi chú">
                <Textarea placeholder="Ghi chú nội bộ…" rows={3} />
              </FormField>
              <FormField label="Tìm kiếm (disabled)">
                <Input disabled placeholder="Không khả dụng" />
              </FormField>
            </CardContent>
            <CardFooter>
              <Button>Lưu</Button>
              <Button variant="ghost">Huỷ</Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tuỳ chọn</CardTitle>
              <CardDescription>Switch cho bật/tắt tức thì, Checkbox cho lựa chọn trong form.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Switch checked={notify} onCheckedChange={setNotify} label="Thông báo tin nhắn mới" description="Hiện thông báo desktop khi có tin nhắn." />
              <Switch checked={sound} onCheckedChange={setSound} label="Âm thanh" />
              <Switch checked disabled onCheckedChange={() => {}} label="Bắt buộc (khoá)" size="sm" />
              <div className="h-px bg-border" />
              <Checkbox checked={agree} onCheckedChange={setAgree} label="Đồng bộ tin nhắn cũ" description="Tải 30 ngày gần nhất khi thêm tài khoản." />
              <Checkbox checked={false} onCheckedChange={() => {}} label="Ẩn hội thoại đã lưu trữ" />
              <Checkbox checked disabled onCheckedChange={() => {}} label="Khoá bởi quản trị" />
              <div className="h-px bg-border" />
              <div className="space-y-1.5">
                <Label>Tìm nhanh</Label>
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle-foreground" />
                  <Input className="pl-8" placeholder="Tìm hội thoại, khách hàng…" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </Section>

      {/* ── Badges ── */}
      <Section title="Badge" description="Một bảng trạng thái dùng chung: cùng nhãn, cùng màu ở mọi màn.">
        <Card>
          <CardContent className="space-y-3">
            <Row label="variant">
              <Badge>Mặc định</Badge>
              <Badge variant="primary">Đang xử lý</Badge>
              <Badge variant="success">Hoàn tất</Badge>
              <Badge variant="warning">Chờ duyệt</Badge>
              <Badge variant="destructive">Thất bại</Badge>
              <Badge variant="info">Mới</Badge>
              <Badge variant="outline">Nhãn</Badge>
            </Row>
            <Row label="dot">
              <Badge dot variant="success">Online</Badge>
              <Badge dot variant="warning">Bận</Badge>
              <Badge dot>Offline</Badge>
            </Row>
            <Row label="size sm">
              <Badge size="sm" variant="primary">Zalo</Badge>
              <Badge size="sm" variant="info">Facebook</Badge>
              <Badge size="sm" variant="outline">Telegram</Badge>
              <Badge size="sm">12</Badge>
            </Row>
          </CardContent>
        </Card>
      </Section>

      {/* ── Cards + list rows ── */}
      <Section title="Card và dòng danh sách" description="Card có viền, không bóng. Dòng danh sách hover bg-muted, đang chọn bg-accent.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader actions={<Button size="sm" variant="outline" leftIcon={<FilterIcon className="h-3.5 w-3.5" />}>Lọc</Button>}>
              <CardTitle>Hội thoại gần đây</CardTitle>
              <CardDescription>3 hội thoại chưa đọc</CardDescription>
            </CardHeader>
            <CardContent padding="none" className="pt-3">
              {[
                { name: 'Nguyễn Văn A', msg: 'Em gửi báo giá giúp anh nhé', time: '09:41', unread: 2, active: true },
                { name: 'Shop Hoa Tươi', msg: 'Đơn #1042 đã giao', time: 'Hôm qua', unread: 0, active: false },
                { name: 'Nhóm CSKH', msg: 'Lan: ok chị', time: 'T2', unread: 5, active: false },
              ].map((r) => (
                <div key={r.name} className={cn('flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted', r.active && 'bg-accent')}>
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-medium text-primary">{r.name[0]}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{r.name}</span>
                      <span className="shrink-0 text-[11px] text-subtle-foreground">{r.time}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">{r.msg}</span>
                      {r.unread > 0 && <Badge size="sm" variant="primary">{r.unread}</Badge>}
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Thống kê hôm nay</CardTitle>
              <CardDescription>So với hôm qua</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Tin nhắn', value: '1.284', delta: '+12%', up: true },
                  { label: 'Khách mới', value: '37', delta: '+4', up: true },
                  { label: 'Chưa trả lời', value: '9', delta: '-3', up: false },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg bg-muted p-3">
                    <div className="text-xs text-muted-foreground">{s.label}</div>
                    <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{s.value}</div>
                    <div className={cn('mt-0.5 text-xs', s.up ? 'text-success' : 'text-destructive')}>{s.delta}</div>
                  </div>
                ))}
              </div>
            </CardContent>
            <CardFooter>
              <Button variant="link" size="sm">Xem báo cáo đầy đủ</Button>
            </CardFooter>
          </Card>
        </div>
      </Section>

      {/* ── Tabs ── */}
      <Section title="Tabs" description="underline cho điều hướng trang; pills cho bộ lọc nhỏ.">
        <Card>
          <CardContent className="space-y-6">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="all" icon={<InboxIcon className="h-4 w-4" />} count={24}>Tất cả</TabsTrigger>
                <TabsTrigger value="unread" icon={<MessageIcon className="h-4 w-4" />} count={3}>Chưa đọc</TabsTrigger>
                <TabsTrigger value="groups" icon={<UsersIcon className="h-4 w-4" />}>Nhóm</TabsTrigger>
                <TabsTrigger value="archived" disabled>Lưu trữ</TabsTrigger>
              </TabsList>
              <TabsContent value="all" className="pt-3 text-sm text-muted-foreground">Danh sách tất cả hội thoại.</TabsContent>
              <TabsContent value="unread" className="pt-3 text-sm text-muted-foreground">Chỉ hội thoại chưa đọc.</TabsContent>
              <TabsContent value="groups" className="pt-3 text-sm text-muted-foreground">Chỉ nhóm.</TabsContent>
            </Tabs>
            <Tabs value={pillTab} onValueChange={setPillTab} variant="pills">
              <TabsList>
                <TabsTrigger value="day">Hôm nay</TabsTrigger>
                <TabsTrigger value="week">7 ngày</TabsTrigger>
                <TabsTrigger value="month">30 ngày</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardContent>
        </Card>
      </Section>

      {/* ── Overlays ── */}
      <Section title="Dialog · Dropdown · Tooltip" description="Mọi popup dùng bg-popover + border. Backdrop bg-black/60 ở cả hai theme.">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => setDialogOpen(true)}>Mở dialog xác nhận</Button>
            <Button variant="outline" onClick={() => setFormDialogOpen(true)}>Mở dialog form</Button>
            <DropdownMenu
              align="start"
              trigger={<Button variant="outline" rightIcon={<ChevronDownIcon className="h-4 w-4" />}>Thao tác</Button>}
            >
              <DropdownMenuLabel>Hội thoại</DropdownMenuLabel>
              <DropdownMenuItem icon={<EditIcon className="h-4 w-4" />} onSelect={() => {}} shortcut="E">Đổi tên</DropdownMenuItem>
              <DropdownMenuItem icon={<CopyIcon className="h-4 w-4" />} onSelect={() => {}}>Sao chép link</DropdownMenuItem>
              <DropdownMenuItem icon={<BellIcon className="h-4 w-4" />} onSelect={() => {}} disabled>Tắt thông báo</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<TrashIcon className="h-4 w-4" />} destructive onSelect={() => {}}>Xoá hội thoại</DropdownMenuItem>
            </DropdownMenu>
            <Tooltip content="Gửi tin nhắn (Enter)">
              <Button size="icon" aria-label="Gửi"><SendIcon className="h-4 w-4" /></Button>
            </Tooltip>
            <Tooltip content="Hồ sơ khách hàng" side="bottom">
              <Button size="icon" variant="ghost" aria-label="Hồ sơ"><UserIcon className="h-4 w-4" /></Button>
            </Tooltip>
          </CardContent>
        </Card>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen} size="sm">
          <DialogHeader>
            <div>
              <DialogTitle>Xoá hội thoại?</DialogTitle>
              <DialogDescription>Tin nhắn sẽ bị xoá khỏi Deplao. Không thể hoàn tác.</DialogDescription>
            </div>
            <DialogClose />
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Huỷ</Button>
            <Button variant="destructive" onClick={() => setDialogOpen(false)}>Xoá</Button>
          </DialogFooter>
        </Dialog>

        <Dialog open={formDialogOpen} onOpenChange={setFormDialogOpen} size="md">
          <DialogHeader>
            <div>
              <DialogTitle>Thêm nhãn mới</DialogTitle>
              <DialogDescription>Nhãn dùng để phân loại khách hàng trong CRM.</DialogDescription>
            </div>
            <DialogClose />
          </DialogHeader>
          <DialogBody className="space-y-4">
            <FormField label="Tên nhãn" required>
              <Input autoFocus placeholder="VD: Khách VIP" />
            </FormField>
            <FormField label="Màu">
              <Select defaultValue="primary">
                <option value="primary">Xanh</option>
                <option value="success">Lục</option>
                <option value="warning">Cam</option>
              </Select>
            </FormField>
            <FormField label="Mô tả" hint="Tuỳ chọn">
              <Textarea rows={3} placeholder="Khách mua trên 10 triệu/tháng" />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFormDialogOpen(false)}>Huỷ</Button>
            <Button onClick={() => setFormDialogOpen(false)}>Tạo nhãn</Button>
          </DialogFooter>
        </Dialog>
      </Section>

      {/* ── Feedback ── */}
      <Section title="Trạng thái rỗng và thông báo">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <EmptyState
              icon={<InboxIcon className="h-6 w-6" />}
              title="Chưa có hội thoại"
              description="Khi khách nhắn tin qua Zalo, Facebook hoặc Telegram, hội thoại sẽ hiện ở đây."
              action={<Button leftIcon={<PlusIcon className="h-4 w-4" />}>Thêm tài khoản</Button>}
            />
          </Card>
          <Card>
            <CardContent className="space-y-3">
              {[
                { icon: <CheckCircleIcon className="h-4 w-4" />, cls: 'border-success/30 bg-success/10 text-success', text: 'Đã đồng bộ 1.284 tin nhắn.' },
                { icon: <AlertIcon className="h-4 w-4" />, cls: 'border-warning/30 bg-warning/10 text-warning', text: 'Tài khoản Zalo sắp hết phiên đăng nhập.' },
                { icon: <AlertIcon className="h-4 w-4" />, cls: 'border-destructive/30 bg-destructive/10 text-destructive', text: 'Không gửi được tin nhắn. Thử lại?' },
                { icon: <InfoIcon className="h-4 w-4" />, cls: 'border-info/30 bg-info/10 text-info', text: 'Phiên bản 26.10.2 đã sẵn sàng cài đặt.' },
              ].map((n) => (
                <div key={n.text} className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm', n.cls)}>
                  {n.icon}
                  <span className="text-foreground">{n.text}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </Section>
    </div>
  );
}

export default DesignSystemPage;
