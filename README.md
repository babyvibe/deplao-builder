<div align="center">

<img src="https://deplaoapp.com/assets/icon-CuJ0M91u.png" alt="Deplao" width="120" />

# Deplao

**Phần mềm desktop quản lý tài khoản Zalo, Facebook & Telegram đa tài khoản**
Tích hợp CRM · MARKETING · ERP · POS · Workflow · Trợ lý AI - vận hành tập trung trong một app duy nhất

[🌐 Website](https://deplaoapp.com/) · [🇬🇧 English](./README.en.md)

![Version](https://img.shields.io/badge/version-26.9.0-22c55e)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Ubuntu-3b82f6)
![Electron](https://img.shields.io/badge/Electron-41-47848f?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/github/license/babyvibe/deplao-builder)
![Stars](https://img.shields.io/github/stars/babyvibe/deplao-builder?style=social)
![Forks](https://img.shields.io/github/forks/babyvibe/deplao-builder?style=social)

</div>

<p align="center">
  <a href="#-tải-xuống">📥 Tải xuống</a> &nbsp;|&nbsp;
  <a href="#-công-nghệ-ngôn-ngữ-sử-dụng">🛠️ Công nghệ</a> &nbsp;|&nbsp;
  <a href="#cài-đặt">📦 Cài đặt</a> &nbsp;|&nbsp;
  <a href="#public-api-scan-group">🌐 Public API</a> &nbsp;|&nbsp;
  <a href="#-các-nhóm-tính-năng-chính">✨ Tính năng</a> &nbsp;|&nbsp;
  <a href="#-bảo-mật-dữ-liệu">🔒 Bảo mật</a> &nbsp;|&nbsp;
  <a href="#-giấy-phép">📝 MIT</a> &nbsp;|&nbsp;
  <a href="#-liên-hệ">📞 Liên hệ</a>
</p>

---

## ⬇️ Tải xuống

<table>
<tr>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-Setup-26.9.0.exe">
<img src="https://img.shields.io/badge/🪟_Windows_10/11-v26.9.0-0078d4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows" />
</a>

<big><strong>Deplao-Setup-26.9.0.exe</strong></big>

</td>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-26.9.0-arm64.dmg">
<img src="https://img.shields.io/badge/🍎_macOS_M1+-v26.9.0-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Apple Silicon" />
</a>

<big><strong>Deplao-26.9.0-arm64.dmg</strong></big>

</td>
</tr>
<tr>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-26.9.0.AppImage">
<img src="https://img.shields.io/badge/🐧_Ubuntu_Linux-v26.9.0-e95420?style=for-the-badge&logo=ubuntu&logoColor=white" alt="Download Ubuntu" />
</a>

<big><strong>Deplao-26.9.0.AppImage</strong></big><br>
<big>chạy mọi distro - <code>chmod +x</code> là dùng được</big>

</td>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-26.9.0.dmg">
<img src="https://img.shields.io/badge/🍎_macOS_Intel-v26.9.0-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Intel" />
</a>

<big><strong>Deplao-26.9.0.dmg</strong></big>

</td>
</tr>
</table>

<p align="center">
👉 <strong><a href="https://github.com/babyvibe/deplao-builder/releases">Xem tất cả phiên bản</a></strong>
</p>

<details>
<summary>⚠️ Lưu ý khi mở file cài đặt (bị chặn bởi Windows / macOS / Linux)</summary>

Do Deplao chưa được ký chứng chỉ (code signing) - nói thẳng ra là nghèo, nên hệ điều hành có thể hiển thị cảnh báo khi mở file. Bạn có thể làm theo hướng dẫn dưới đây:

---

### 🪟 Windows (.exe)

Khi mở file `.exe`, Windows có thể hiển thị cảnh báo **"Windows protected your PC"**:

👉 Cách xử lý:
1. Nhấn **More info**
2. Chọn **Run anyway**

---

### 🍎 macOS (.dmg)

Khi mở file `.dmg`, macOS có thể báo **"cannot be opened because it is from an unidentified developer"**

👉 Cách xử lý:

**Cách 1:**
- Chuột phải vào file → chọn **Open**
- Nhấn **Open** lần nữa

**Cách 2 (nếu vẫn bị chặn):**
1. Vào **System Settings → Privacy & Security**
2. Kéo xuống phần Security
3. Nhấn **Open Anyway**

---

### 🐧 Ubuntu Linux (.AppImage)

Sau khi tải file `.AppImage`:

```bash
chmod +x Deplao-*.AppImage
./Deplao-*.AppImage
```

> Nếu gặp lỗi "FUSE: fuse2 not available", cài `libfuse2`:
> ```bash
> sudo apt install libfuse2
> ```

Hoặc cài bản `.deb`:
```bash
sudo dpkg -i Deplao_*_amd64.deb
```

</details>

<p align="center">
  <img src="./assets/deplao-overview-map.svg" alt="Sơ đồ trực quan mô tả Deplao là workspace desktop tập trung cho bán hàng và chăm sóc khách hàng trên Zalo" width="960" />
</p>

## 🛠️ Công nghệ & ngôn ngữ sử dụng

Deplao hiện được xây dựng trên các công nghệ chính sau:

- **Thư viện chính:** zca-js & fbchat-v2
- **AI Gateway:** 9router
- **Ngôn ngữ:** TypeScript, JavaScript, SQL, HTML, CSS
- **Ứng dụng desktop:** Electron, React, Vite
- **Giao diện:** Tailwind CSS, PostCSS, React Router
- **Lưu trữ dữ liệu cục bộ:** SQLite qua `better-sqlite3`
- **State & UI chuyên biệt:** Zustand, React Flow, Recharts, Quill
- **Backend dịch vụ:** Node.js + Express
- **Tích hợp & automation:** Axios, Google APIs / Google Sheets, node-cron, Discord.js, Telegram Bot API, OpenAI API, v.v.

---


## Cài đặt

<details open>
<summary>🛠️ Tự build từ source</summary>

### Yêu cầu

- Windows 10/11, macOS (Apple Silicon), hoặc Ubuntu 20.04+
- Node.js 18+ khuyến nghị
- npm 9+

### Cài đặt

```powershell
npm install --legacy-peer-deps
```

### Chạy development

```powershell
npm run dev
```

### Build app

```powershell
npm run production
```

### Dữ liệu cục bộ

- Dữ liệu app dùng SQLite cục bộ
- Có thể đổi thư mục lưu trữ trong phần `Cài đặt`

</details>

## 🗺️ Sơ đồ kiến trúc & luồng hoạt động

---

### 1️⃣ Luồng Build

```mermaid
flowchart LR
    subgraph SRC["📁 Source Code"]
        E("⚡ electron/\n*.ts")
        S("🔧 services/\n*.ts")
        R("🎨 src/ui/\n*.tsx")
    end

    subgraph COMPILE["🔨 Compile"]
        TSC("tsc\ntsconfig.electron")
        VITE("vite build\n+ Tailwind CSS")
    end

    subgraph OUT["📦 Output"]
        DE("dist-electron/\nmain · services · ipc")
        D("dist/\nindex.html · assets")
    end

    subgraph PKG["🚀 Đóng gói"]
        EB(("electron\nbuilder"))
        WIN("🪟 Windows\n.exe / dir")
        MAC("🍎 macOS\n.dmg arm64")
        LIN("🐧 Linux\n.AppImage · .deb")
    end

    E & S --> TSC --> DE
    R --> VITE --> D
    DE & D --> EB --> WIN & MAC & LIN
```

---

### 2️⃣ Kiến trúc Runtime

```mermaid
mindmap
  root((🖥️ Deplao))
    ⚙️ Main Process
      📡 IPC Handlers
        login · zalo · crm
        workflow · erp · sync
        facebook · relay · file
      🔧 Services
        DatabaseService
        WorkspaceManager
        WorkflowEngine
        CRMQueueService
        HttpConnectionManager
        FileStorageService
        AIAssistantService
    🎨 Renderer
      ⚛️ React Pages
        Dashboard
        Chat & Inbox
        CRM & Campaign
        Workflow Editor
        POS & Tích hợp
        ERP · Settings
      🗃️ Zustand State
        accountStore
        chatStore
        workspaceStore
        employeeStore
    📱 Giao thức Zalo
      zca-js
        QR Login
        Cookie Session
        WebSocket realtime
    🌐 External APIs
      OpenAI · Google Sheets
      Telegram · Discord
      KiotViet · Haravan · Sapo
      GHN · GHTK
```

---

### 3️⃣ Mô hình Boss ↔ Nhân viên (REST API)

```mermaid
flowchart TB
    subgraph BOSS["🖥️ Máy BOSS - Local Workspace"]
        BZ("📱 Zalo / FB\nAccounts")
        BSV("🔧 Services\nCRM · ERP · AI · Workflow · Library")
        BSD[("🗄️ SQLite DB\n+ Media Files")]
        BRL("🔁 Relay Server\nHTTP REST + Socket.IO :9900")
        BRS("📡 REST API Handlers\n/api/query | /api/command\n/api/library | /api/media")
    end

    subgraph NET["🌐 Kết nối"]
        LAN("🏠 LAN\n192.168.x.x:9900")
        WAN("🌍 Tunnel / VPN\ntruy cập từ xa")
    end

    subgraph EMP["💻 Nhân Viên - Remote Workspace"]
        EA("📲 Deplao App\nEmployee Mode")
        DA("🔀 DataAccessor\ntự động routing")
        RQ("🌐 RestQueryService\nHTTP REST client")
        EP("🔐 Permission Filter\nerp · crm · workflow · ...")
        EU("👁️ UI\nchỉ thấy TK được gán")
        MC("📦 Media Cache\nworkspace → Boss → CDN")
        EC("⚡ Employee Cache\nconversations · messages · labels")
    end

    BZ --> BSV
    BSV <--> BSD
    BSV --> BRL
    BRL --> BRS
    BRL <-->|HTTP REST + Socket.IO| LAN & WAN
    LAN <-->|HTTP fetch| RQ
    WAN <-->|HTTP fetch| RQ
    RQ -->|/api/query · /api/command| BRS
    RQ -->|/api/media| MC
    RQ -->|/api/library| BSV
    EA --> DA -->|boss mode → IPC| EU
    DA -->|employee → REST| RQ
    EA --> EP --> EU
    EA --> EC
    EA --> MC
```

> **Kiến trúc mới từ v26.9.0:** Employee gọi dữ liệu qua **REST API** (HTTP fetch → Boss) thay vì sync toàn bộ DB như trước. DataAccessor tự động routing: standalone/boss → IPC trực tiếp, employee → RestQueryService → Boss. Socket.IO thay SSE cho realtime event ổn định hơn. Media được cache local với cascade workspace → Boss → CDN. Employee vẫn có workspace riêng, nhưng không cần sync hàng GB khi vào app.

---

### 4️⃣ Đa tài khoản & Lưu trữ

```mermaid
flowchart LR
    subgraph ACCS["👤 Tài khoản"]
        Z1("Zalo #1\nzca-js")
        Z2("Zalo #2\nzca-js")
        ZN("Zalo #N\nzca-js")
        FB("Facebook\nGraph API")
    end

    subgraph STORE["💾 Lưu trữ cục bộ"]
        DB[("🗄️ SQLite\ndeplao-tool.db\nmessages · contacts\ncrm · workflow · erp")]
        MED("📁 FileStorage\n~/media/\nảnh · video · file")
        ES("🔑 electron-store\ncookies · tokens\nsettings")
    end

    subgraph WS["🗂️ Workspace Manager"]
        WA("🏠 Local WS\nDefault")
        WB("🌐 Remote WS\nBoss")
        WC("⚙️ Custom WS\npath tuỳ chỉnh")
    end

    Z1 & Z2 & ZN & FB -->|"tin nhắn · danh bạ"| DB
    Z1 & Z2 & ZN & FB -->|"ảnh · video · file"| MED
    ES -->|"cookie session"| Z1 & Z2 & ZN
    DB & ES <-->|"path resolve\nswitch workspace"| WS
    WA & WB & WC -.-|"mỗi WS = DB riêng"| DB
```

> Mỗi **Workspace** có DB + media folder độc lập - đổi hoặc di chuyển sang ổ đĩa khác không mất dữ liệu.

---


<a id="public-api-scan-group"></a>

## 🌐 Public API - Quét thành viên nhóm Zalo

Deplao cung cấp API quét danh sách thành viên của nhóm Zalo. API này **không yêu cầu gói premium hay kiểm tra hạn dùng**; tuy nhiên request phải dùng phiên đăng nhập Zalo hợp lệ của chính bạn. Chỉ quét dữ liệu mà tài khoản đó có quyền truy cập và tuân thủ điều khoản của Zalo cùng quy định về dữ liệu cá nhân.

### Endpoint

```http
POST https://deplaoapp.com/api/scan/group
Content-Type: application/json
x-api-key: fb7457b7a39bdc9e742f08b657a8059a5e6a8fda6e32bfe0bfecf37eadf519eb
```

`x-api-key` là key public, cũng có trong `src/ui/lib/backendService.ts`, để client Deplao và tích hợp ngoài cùng dùng đúng contract. Deplao sử dụng API riêng cùng envelope AES để hạn chế việc gọi trực tiếp hoặc giả mạo payload một cách đơn giản; đây không phải là lớp xác thực thay thế cho việc bảo vệ cookie của bạn. Cookie và IMEI vẫn là dữ liệu phiên nhạy cảm: không đưa chúng vào Git, log công khai hoặc frontend không kiểm soát được.

### Tham số

Request dùng một envelope gồm `page_id` và `body`. `body` là chuỗi Base64 được mã hóa AES-128-CBC (IV gồm 16 byte `0x00`), với key là 16 byte đầu của API key dạng hex. Payload sau khi giải mã có các trường sau:

| Trường | Kiểu | Bắt buộc | Mô tả |
| --- | --- | :---: | --- |
| `page_id` | `string` | Có | ID của tài khoản/trang Zalo đang dùng để quét. Giá trị này có mặt cả ở envelope lẫn payload mã hóa. |
| `cookie` | `string` | Có | Cookie phiên Zalo còn hiệu lực của tài khoản thực hiện quét. |
| `imei` | `string` | Có | IMEI/device ID đã ghép với phiên Zalo đó. |
| `groupId` | `string` | Có | ID nhóm Zalo dạng số. Nếu đang có link mời/link nhóm, hãy resolve sang Group ID trước khi gọi API. |

### Ví dụ Node.js

```js
import crypto from 'node:crypto';

const endpoint = 'https://deplaoapp.com/api/scan/group';
const apiKey = 'fb7457b7a39bdc9e742f08b657a8059a5e6a8fda6e32bfe0bfecf37eadf519eb';

function encryptBody(payload) {
  const key = Buffer.from(apiKey, 'hex').subarray(0, 16);
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64');
}

const pageId = process.env.ZALO_PAGE_ID;
const body = {
  page_id: pageId,
  cookie: process.env.ZALO_COOKIE,
  imei: process.env.ZALO_IMEI,
  groupId: '1234567890123456789',
};

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
  },
  body: JSON.stringify({ page_id: pageId, body: encryptBody(body) }),
});

const result = await response.json();
if (!result.success) throw new Error(result.error || 'Quét nhóm thất bại');
console.log(`Đã nhận ${result.totalMembers} thành viên`);
```

### Response thành công

```json
{
  "success": true,
  "groupId": "1234567890123456789",
  "totalMembers": 2,
  "members": [
    {
      "userId": "987654321",
      "id": "987654321",
      "globalId": "987654321_0",
      "displayName": "Nguyễn An",
      "zaloName": "Nguyễn An",
      "avatar": "https://zalo-ava.example/avatar.jpg",
      "accountStatus": 1,
      "type": 0,
      "lastUpdateTime": 1726824000000
    }
  ]
}
```

| Trường response | Mô tả |
| --- | --- |
| `success` | `true` khi backend hoàn tất quét. |
| `groupId` | Group ID đã được quét. |
| `totalMembers` | Tổng số thành viên trả về trong lần quét. |
| `members` | Danh sách thành viên. `userId`/`id` là ID người dùng; `globalId` là định danh đầy đủ của Zalo; các trường tên, avatar và trạng thái có thể rỗng tùy quyền dữ liệu của Zalo. |
| `accountStatus`, `type`, `lastUpdateTime` | Metadata trạng thái do Zalo trả về; giữ nguyên để ứng dụng gọi API tự diễn giải khi cần. |

### Response lỗi

```json
{
  "success": false,
  "groupId": "1234567890123456789",
  "totalMembers": 0,
  "members": [],
  "error": "Cookie Zalo đã hết hạn hoặc không có quyền truy cập nhóm"
}
```

Các nguyên nhân thường gặp: API key không hợp lệ, thiếu tham số, cookie/IMEI không còn khớp phiên Zalo, Group ID sai hoặc tài khoản không có quyền xem nhóm, và giới hạn tạm thời từ Zalo. Luôn kiểm tra `success` trước khi dùng `members`; không retry dồn dập khi upstream đang từ chối request.

### Lưu ý quyền riêng tư, điều khoản và trách nhiệm

- Tính năng quét trong Deplao và Public API này hiện **không thu phí** và không kiểm tra hạn dùng.
- Cookie của bạn chỉ được gửi trong request mã hóa để thực hiện lượt quét; **Deplao không lưu trữ cookie này trên server** sau khi xử lý request.
- Khi dùng tính năng trong Deplao hoặc gọi Public API, bạn xác nhận đã đọc và đồng ý với chính sách, điều khoản sử dụng của Deplao; đồng thời tự chịu trách nhiệm về tài khoản, nhóm và dữ liệu mình quét.
- Kết quả phụ thuộc vào phiên Zalo, quyền truy cập nhóm và phản hồi từ Zalo. Deplao không chịu trách nhiệm cho việc tài khoản bị hạn chế, lỗi dữ liệu, thay đổi từ nền tảng hoặc bất kỳ vấn đề phát sinh từ việc sử dụng tính năng/API này.
- Hãy cân nhắc kỹ trước khi sử dụng, chỉ quét dữ liệu cần thiết và không dùng kết quả để spam, xâm phạm quyền riêng tư hoặc vi phạm điều khoản của Zalo.

## 🚀 Deplao là gì?

Nếu nhìn nhanh, có thể hiểu Deplao là:

- **trung tâm vận hành**: nhiều tài khoản, inbox tập trung, trả lời nhanh
- **lớp quản lý khách hàng**: CRM, nhãn, lịch sử tương tác, campaign
- **lớp tự động hóa**: workflow, AI, trigger và action chạy nền
- **lớp kết nối kinh doanh**: POS, vận chuyển, API và công cụ ngoài
- **lớp quản trị nội bộ**: báo cáo, ERP, phân quyền, workspace nhân viên

## ✨ Điểm nổi bật

- 👤 **Đa tài khoản Zalo, Facebook, Telegram Bot, Telegram User** - đăng nhập không giới hạn tài khoản, chuyển đổi qua lại nhanh
- 💬 **Hộp thư tập trung** - chế độ gộp tài khoản giúp gom và xử lý hội thoại từ nhiều tài khoản trong một giao diện duy nhất
- 👥 **CRM & Campaign** - quản lý liên hệ, nhãn, ghi chú nội bộ, chăm sóc khách cũ. Quét thành viên nhóm ẩn, nhóm chưa tham gia để tìm khách mới.
- ⚙️ **Workflow tự động hóa** - kéo-thả Trigger → Node → Action hoặc dùng AI tạo quy trình, chạy nền 24/7 không cần code
- 🤖 **AI Assistant** - hỗ trợ gợi ý câu trả lời, chat trực tiếp trong hội thoại. Còn giúp phân loại tin nhắn, trả lời khách hàng 24/7.
- 🔗 **Tích hợp ngoài** - POS, vận chuyển, thanh toán, Google Sheets, Telegram, Discord, Email, HTTP Request... Kết hợp sử dụng khi chat hoặc workflow
- 📈 **Báo cáo & phân tích** - theo dõi tin nhắn, liên hệ, nhãn, nhân viên, chiến dịch, workflow, AI.
- 🗂️ **ERP nội bộ** - task, lịch làm việc, notes và phối hợp vận hành nội bộ ngay trong cùng hệ thống
- 🧑‍💼 **Workspace boss ↔ nhân viên** - kết nối qua **LAN hoặc WAN**, phân quyền chi tiết và theo dõi hiệu suất từng nhân viên
- 🔒 **Proxy per-account** - gán Proxy riêng cho từng tài khoản Zalo trước khi đăng nhập
- 🔐 **Dữ liệu lưu cục bộ** - ưu tiên quyền kiểm soát dữ liệu và bảo mật trên máy người dùng


### Xem nhanh giao diện Deplao

Các màn hình dưới đây được sắp theo luồng sử dụng thực tế: từ dashboard → chat → CRM → workflow → POS / báo cáo / ERP.

<table>
  <tr>
    <td>
      <img src="./assets/dashboard.png" alt="Dashboard quản lý đa tài khoản Zalo trong Deplao" width="360" />
      <br />
      <sub><strong>Dashboard đa tài khoản</strong></sub>
    </td>
    <td>
      <img src="./assets/chat.png" alt="Giao diện chat tập trung trong Deplao" width="360" />
      <br />
      <sub><strong>Chat tập trung tích hợp AI gợi ý trả lời</strong></sub>
    </td>
    <td>
      <img src="./assets/crm.png" alt="Màn hình CRM và quản lý liên hệ trong Deplao" width="360" />
      <br />
      <sub><strong>CRM & liên hệ</strong></sub>
    </td>
  </tr>
  <tr>
    <td>
      <img src="./assets/scan-members-group.png" alt="Quét thành viên nhóm Zalo trong Deplao" width="360" />
      <br />
      <sub><strong>Quét thành viên nhóm</strong></sub>
    </td>
    <td>
      <img src="./assets/campaign.png" alt="Chiến dịch gửi tin hàng loạt trong Deplao" width="360" />
      <br />
      <sub><strong>Chiến dịch gửi tin hàng loạt</strong></sub>
    </td>
    <td>
      <img src="./assets/workflow.png" alt="Trình thiết kế workflow kéo thả trong Deplao" width="360" />
      <br />
      <sub><strong>Workflow editor</strong></sub>
    </td>
  </tr>
  <tr>
    <td>
      <img src="./assets/detail-workflow.png" alt="Chi tiết cấu hình workflow trong Deplao" width="360" />
      <br />
      <sub><strong>Chi tiết workflow</strong></sub>
    </td>
    <td>
      <img src="./assets/workflow-ai.png" alt="Workflow kết hợp AI trong Deplao" width="360" />
      <br />
      <sub><strong>Ra lệnh tạo Workflow bằng AI</strong></sub>
    </td>
    <td>
      <img src="./assets/pos.png" alt="Tích hợp POS và bán hàng trong Deplao" width="360" />
      <br />
      <sub><strong>Tích hợp POS, VC, Thanh toán</strong></sub>
    </td>
  </tr>
  <tr>
    <td>
      <img src="./assets/report.jpg" alt="Báo cáo và phân tích hiệu suất trong Deplao" width="360" />
      <br />
      <sub><strong>Báo cáo & phân tích</strong></sub>
    </td>
    <td>
      <img src="./assets/report-employee.png" alt="Báo cáo hiệu suất nhân viên trong Deplao" width="360" />
      <br />
      <sub><strong>Báo cáo nhân viên</strong></sub>
    </td>
    <td>
      <img src="./assets/erp.png" alt="ERP nội bộ và phối hợp vận hành trong Deplao" width="360" />
      <br />
      <sub><strong>ERP nội bộ</strong></sub>
    </td>
  </tr>
</table>

## 🎯 Phù hợp với ai?

Deplao phù hợp cho:

- Shop online và đội ngũ chốt đơn qua Zalo, Facebook, Telegram
- Tự động hoá quy trình làm việc, kết hợp marketing để tìm kiếm khách hàng mới, tự động hóa chăm sóc khách hàng
- Doanh nghiệp SME cần nhiều nhân viên xử lý inbox cùng lúc
- Marketing agency hoặc freelancer quản lý nhiều tài khoản khách hàng
- Spa, phòng khám, giáo dục, F&B và các mô hình cần chăm sóc khách hàng định kỳ
- Đội nhóm muốn kết hợp chat, CRM, workflow, AI và ERP trong một desktop app duy nhất

## 🧩 Các nhóm tính năng chính

### 1) Quản lý đa tài khoản & inbox tập trung
- Đăng nhập nhiều tài khoản Zalo, Facebook, Telegram bot, Telegram user
- Dashboard quản lý tài khoản trực quan
- Gộp nhiều tài khoản vào một inbox hợp nhất
- Tìm kiếm theo tên, biệt danh, số điện thoại
- Lọc nhanh theo chưa đọc, chưa trả lời, nhãn và trạng thái hội thoại
- Gắn Proxy riêng cho từng tài khoản Zalo

### 2) Chat đầy đủ tính năng
- Gửi tin nhắn văn bản, ảnh, video, file
- Gửi emoji, sticker, reply, tag thành viên
- Gửi poll, ghi chú nhóm, nhắc nhở, gửi danh thiếp
- Gửi quick messages để lưu mẫu tin và gọi nhanh bằng từ khóa
- Ghim tin nhắn không giới hạn, quản lý media và file đính kèm

### 3) CRM & chăm sóc khách hàng
- Đồng bộ bạn bè, thành viên nhóm và hồ sơ liên hệ
- Lưu số điện thoại, giới tính, ngày sinh, ghi chú nội bộ
- Tạo và quản lý nhãn Zalo hai chiều
- Lọc liên hệ theo nhiều tiêu chí để chăm sóc đúng nhóm khách hàng
- Tạo campaign gửi tin, kết bạn, mời vào nhóm với tiến độ realtime

### 4) Workflow tự động hóa
- Workflow kéo-thả không cần code
- Tích hợp trợ lý AI tạo node và workflow bằng câu lệnh (xem mục 7)
- Hỗ trợ trigger từ tin nhắn, nhãn, react, lịch cron, sự kiện nhóm...
- Action gửi tin, gửi ảnh/file, tìm user, quản lý nhóm, mute, forward, recall...
- Tích hợp logic, Google Sheets, AI, Telegram, Discord, Email, Notion và HTTP Request
- Có lịch sử chạy để kiểm tra và debug dễ dàng

### 5) Tích hợp phục vụ bán hàng
- POS: KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS
- Vận chuyển: GHN, GHTK
- Thanh toán: Sepay, Casso
- AI Assistant gợi ý trả lời, hỏi đáp trực tiếp trong hội thoại (xem mục 7)
- Dễ kết hợp thành quy trình bán hàng và chăm sóc khách hàng khép kín

### 6) Báo cáo, ERP và nhân viên
- Báo cáo tin nhắn, liên hệ, chiến dịch, workflow, AI, nhân viên
- ERP nội bộ gồm Task, Calendar, Notes
- Mô hình boss ↔ nhân viên và phân quyền module
- Hỗ trợ theo dõi hiệu suất làm việc theo từng người và từng giai đoạn

### 7) 🤖 Trợ lý AI (AI Assistant)
- Gợi ý trả lời thông minh trong hội thoại
- Hỏi đáp trực tiếp với AI ngay trong khung chat
- Tạo workflow tự động bằng câu lệnh tiếng Việt mà không cần kéo-thả
- Dùng node AI trong workflow để xây dựng chatbot trả lời tự động 24/7
- Hỗ trợ đa nền tảng AI: OpenAI, Claude, Gemini, Deepseek, Grok,... và các AI gateway local như 9Router, OpenRouter, v.v.

## 🔒 Bảo mật & dữ liệu

Deplao ưu tiên kiến trúc chạy cục bộ trên máy người dùng:

- Tất cả dữ liệu tin nhắn, danh bạ, CRM, cài đặt và media được lưu trên máy
- Đăng nhập bằng QR Code, không yêu cầu lưu mật khẩu Zalo, Cookie được mã hóa lưu trên máy
- Người dùng có thể đổi thư mục lưu trữ dữ liệu sang ổ đĩa khác khi cần
- Phù hợp với đội nhóm muốn kiểm soát dữ liệu nội bộ chặt chẽ hơn

## 💻 Yêu cầu vận hành

- Kết nối Internet 24/7 ổn định để đồng bộ hội thoại và automation
- Nên để app hoạt động liên tục nếu dùng workflow hoặc vận hành đội nhóm


---------------------------------------------------------------------------------------------------------------------------------------------

## 📣 Liên hệ

- Báo lỗi, góp ý hoặc cần hỗ trợ: 👉 [Tạo issue tại đây](https://github.com/babyvibe/deplao-builder/issues)

## 🙏 Lời cảm ơn

Deplao xin gửi lời cảm ơn đến dự án: zca-js & fbchat-v2.

---

## 📝 Giấy phép

Dự án được phân phối dưới giấy phép **MIT**.
Xem file [LICENSE](LICENSE) để biết thêm chi tiết.

---

