# Deplao
*Website Introduction*:  https://deplaoapp.com/

<p>
  <strong>ðŸŒ Language:</strong>
  &nbsp;ðŸ‡»ðŸ‡³ <a href="./README.md">Tiáº¿ng Viá»‡t</a>
  &nbsp;|&nbsp;
  ðŸ‡¬ðŸ‡§ <strong>English</strong>
</p>

---

> A multi-account Zalo & Facebook desktop app with integrated CRM, ERP, POS, Workflow automation and AI Assistant - helping sales, customer care teams and marketing operate centrally on Zalo and Facebook in one single application.

[![Version](https://img.shields.io/badge/version-26.7.4-22c55e)](#)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-3b82f6)](#-runtime-requirements)
[![Electron](https://img.shields.io/badge/Electron-41-47848f?logo=electron&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=white)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](#)
[![SQLite](https://img.shields.io/badge/SQLite-local--first-003b57?logo=sqlite&logoColor=white)](#)
[![Vite](https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white)](#)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](#)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](#license)
[![Support](https://img.shields.io/badge/support-GitHub_Issues-0ea5e9)](https://github.com/babyvibe/deplao-builder/issues)

<p align="center">
  <a href="#-download">ðŸ“¥ Download</a> &nbsp;|&nbsp;
  <a href="#-tech-stack">ðŸ› ï¸ Tech Stack</a> &nbsp;|&nbsp;
  <a href="#installation">ðŸ“¦ Install</a> &nbsp;|&nbsp;
  <a href="#-core-feature-groups">âœ¨ Features</a> &nbsp;|&nbsp;
  <a href="#-security-data">ðŸ”’ Security</a> &nbsp;|&nbsp;
  <a href="#-license">ðŸ“ MIT</a> &nbsp;|&nbsp;
  <a href="#-contact-support">ðŸ“ž Contact</a>
</p>

---

## â¬‡ï¸ Download

<table>
<tr>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-Setup-26.7.4.exe">
<img src="https://img.shields.io/badge/ðŸªŸ_Windows_10/11-v26.7.4-0078d4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows" />
</a>

<big><strong>Deplao-Setup-26.7.4.exe</strong></big>

</td>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-26.7.4-arm64.dmg">
<img src="https://img.shields.io/badge/ðŸŽ_macOS_M1+-v26.7.4-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Apple Silicon" />
</a>

<big><strong>Deplao-26.7.4-arm64.dmg</strong></big>

</td>
</tr>
<tr>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-26.7.4.AppImage">
<img src="https://img.shields.io/badge/ðŸ§_Ubuntu_Linux-v26.7.4-e95420?style=for-the-badge&logo=ubuntu&logoColor=white" alt="Download Ubuntu" />
</a>

<big><strong>Deplao-26.7.4.AppImage</strong></big><br>
<big>works on any distro - <code>chmod +x</code> & run</big>

</td>
<td align="center" width="50%">

<a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-26.7.4.dmg">
<img src="https://img.shields.io/badge/ðŸŽ_macOS_Intel-v26.7.4-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Intel" />
</a>

<big><strong>Deplao-26.7.4.dmg</strong></big>

</td>
</tr>
</table>

<p align="center">
ðŸ‘‰ <strong><a href="https://github.com/babyvibe/deplao-builder/releases">View all releases</a></strong>
</p>

<details>
<summary>âš ï¸ Security warning on first launch (blocked by Windows / macOS / Linux)</summary>

Deplao is not code-signed (we're bootstrapped), so your OS may show a warning when opening the installer.

---

### ðŸªŸ Windows (.exe)

Windows may show **"Windows protected your PC"**:

ðŸ‘‰ How to proceed:
1. Click **More info**
2. Click **Run anyway**

---

### ðŸŽ macOS (.dmg)

macOS may show **"cannot be opened because it is from an unidentified developer"**

ðŸ‘‰ How to proceed:

**Option 1:**
- Right-click the file â†’ **Open**
- Click **Open** again

**Option 2 (if still blocked):**
1. Go to **System Settings â†’ Privacy & Security**
2. Scroll down to Security
3. Click **Open Anyway**

---

### ðŸ§ Ubuntu Linux (.AppImage)

After downloading the `.AppImage` file:

```bash
chmod +x Deplao-*.AppImage
./Deplao-*.AppImage
```

> If you get "FUSE: fuse2 not available", install `libfuse2`:
> ```bash
> sudo apt install libfuse2
> ```

Or install the `.deb` package:
```bash
sudo dpkg -i Deplao_*_amd64.deb
```

</details>

<p align="center">
  <img src="./assets/deplao-overview-map.svg" alt="Deplao - centralized desktop workspace for Zalo sales and customer care" width="960" />
</p>

## ðŸ› ï¸ Tech Stack

- **Core library:** zca-js - https://github.com/RFS-ADRENO/zca-js, fbchat-v2 (Facebook E2EE bridge Go)
- **AI Gateway:** 9router
- **Languages:** TypeScript, JavaScript, SQL, HTML, CSS
- **Desktop:** Electron, React, Vite
- **UI:** Tailwind CSS, PostCSS, React Router
- **Local storage:** SQLite via `better-sqlite3`
- **State & UI:** Zustand, React Flow, Recharts, Quill
- **Backend services:** Node.js + Express
- **Integrations & automation:** Axios, Google APIs / Sheets, node-cron, Discord.js, Telegram Bot API, OpenAI API, etc.

---

## ðŸ—ºï¸ Architecture & Flow Diagrams

---

### 1ï¸âƒ£ Build Pipeline

```mermaid
flowchart LR
    subgraph SRC["ðŸ“ Source Code"]
        E("âš¡ electron/\n*.ts")
        S("ðŸ”§ services/\n*.ts")
        R("ðŸŽ¨ src/ui/\n*.tsx")
    end

    subgraph COMPILE["ðŸ”¨ Compile"]
        TSC("tsc\ntsconfig.electron")
        VITE("vite build\n+ Tailwind CSS")
    end

    subgraph OUT["ðŸ“¦ Output"]
        DE("dist-electron/\nmain Â· services Â· ipc")
        D("dist/\nindex.html Â· assets")
    end

    subgraph PKG["ðŸš€ Package"]
        EB(("electron\nbuilder"))
        WIN("ðŸªŸ Windows\n.exe / dir")
        MAC("ðŸŽ macOS\n.dmg arm64")
        LIN("ðŸ§ Linux\n.AppImage Â· .deb")
    end

    E & S --> TSC --> DE
    R --> VITE --> D
    DE & D --> EB --> WIN & MAC & LIN
```

---

### 2ï¸âƒ£ Runtime Architecture

```mermaid
mindmap
  root((ðŸ–¥ï¸ Deplao))
    âš™ï¸ Main Process
      ðŸ“¡ IPC Handlers
        login Â· zalo Â· crm
        workflow Â· erp Â· sync
        facebook Â· relay Â· file
      ðŸ”§ Services
        DatabaseService
        WorkspaceManager
        WorkflowEngine
        CRMQueueService
        HttpConnectionManager
        FileStorageService
        AIAssistantService
    ðŸŽ¨ Renderer
      âš›ï¸ React Pages
        Dashboard
        Chat & Inbox
        CRM & Campaign
        Workflow Editor
        POS & Integrations
        ERP Â· Settings
      ðŸ—ƒï¸ Zustand State
        accountStore
        chatStore
        workspaceStore
        employeeStore
    ðŸ“± Zalo Protocol
      zca-js
        QR Login
        Cookie Session
        WebSocket realtime
    ðŸŒ External APIs
      OpenAI Â· Google Sheets
      Telegram Â· Discord
      KiotViet Â· Haravan Â· Sapo
      GHN Â· GHTK
```

---

### 3ï¸âƒ£ Boss â†” Employee Model (REST API)

```mermaid
flowchart TB
    subgraph BOSS["ðŸ–¥ï¸ Boss Machine - Local Workspace"]
        BZ("ðŸ“± Zalo / FB\nAccounts")
        BSV("ðŸ”§ Services\nCRM Â· ERP Â· AI Â· Workflow Â· Library")
        BSD[("ðŸ—„ï¸ SQLite DB\n+ Media Files")]
        BRL("ðŸ” Relay Server\nHTTP REST + Socket.IO :9900")
        BRS("ðŸ“¡ REST API Handlers\n/api/query | /api/command\n/api/library | /api/media")
    end

    subgraph NET["ðŸŒ Network"]
        LAN("ðŸ  LAN\n192.168.x.x:9900")
        WAN("ðŸŒ Tunnel / VPN\nremote access")
    end

    subgraph EMP["ðŸ’» Employee Machine - Remote Workspace"]
        EA("ðŸ“² Deplao App\nEmployee Mode")
        DA("ðŸ”€ DataAccessor\nauto-routing layer")
        RQ("ðŸŒ RestQueryService\nHTTP REST client")
        EP("ðŸ” Permission Filter\nerp Â· crm Â· workflow Â· ...")
        EU("ðŸ‘ï¸ UI\nassigned accounts only")
        MC("ðŸ“¦ Media Cache\nworkspace â†’ Boss â†’ CDN")
        EC("âš¡ Employee Cache\nconversations Â· messages Â· labels")
    end

    BZ --> BSV
    BSV <--> BSD
    BSV --> BRL
    BRL --> BRS
    BRL <-->|HTTP REST + Socket.IO| LAN & WAN
    LAN <-->|HTTP fetch| RQ
    WAN <-->|HTTP fetch| RQ
    RQ -->|/api/query Â· /api/command| BRS
    RQ -->|/api/media| MC
    RQ -->|/api/library| BSV
    EA --> DA -->|boss mode â†’ IPC| EU
    DA -->|employee â†’ REST| RQ
    EA --> EP --> EU
    EA --> EC
    EA --> MC
```

> **New architecture since v26.7.4:** Employees fetch data via **REST API** (HTTP fetch â†’ Boss) instead of syncing the entire database as before. DataAccessor auto-routes: standalone/boss â†’ direct IPC, employee â†’ RestQueryService â†’ Boss. Socket.IO replaces SSE for more reliable real-time events. Media is cached locally with a workspace â†’ Boss â†’ CDN cascade. Employees still have their own workspace, but no longer need to sync gigabytes of data when launching the app.

---

### 4ï¸âƒ£ Multi-account & Local Storage

```mermaid
flowchart LR
    subgraph ACCS["ðŸ‘¤ Accounts"]
        Z1("Zalo #1\nzca-js")
        Z2("Zalo #2\nzca-js")
        ZN("Zalo #N\nzca-js")
        FB("Facebook\nGraph API")
    end

    subgraph STORE["ðŸ’¾ Local Storage"]
        DB[("ðŸ—„ï¸ SQLite\ndeplao-tool.db\nmessages Â· contacts\ncrm Â· workflow Â· erp")]
        MED("ðŸ“ FileStorage\n~/media/\nimages Â· videos Â· files")
        ES("ðŸ”‘ electron-store\ncookies Â· tokens\nsettings")
    end

    subgraph WS["ðŸ—‚ï¸ Workspace Manager"]
        WA("ðŸ  Local WS\nDefault")
        WB("ðŸŒ Remote WS\nBoss")
        WC("âš™ï¸ Custom WS\ncustom path")
    end

    Z1 & Z2 & ZN & FB -->|"messages Â· contacts"| DB
    Z1 & Z2 & ZN & FB -->|"images Â· videos Â· files"| MED
    ES -->|"cookie session"| Z1 & Z2 & ZN
    DB & ES <-->|"path resolve\nswitch workspace"| WS
    WA & WB & WC -.-|"each WS = own DB"| DB
```

> Each **Workspace** has its own independent DB + media folder.
> You can move the data directory to another drive without losing any data.

---

## Installation

<details>
<summary>ðŸ› ï¸ Build from source</summary>

### Requirements

- Windows 10/11, macOS (Apple Silicon), or Ubuntu 20.04+
- Node.js 18+ recommended
- npm 9+

### Install dependencies

```powershell
npm install --legacy-peer-deps
```

### Run in development mode

```powershell
npm run dev
```

### Build production app

```powershell
npm run production
```

### Local data

- App data uses local SQLite
- Storage directory can be changed in `Settings`

</details>

## ðŸš€ What is Deplao?

At a glance, Deplao is:

- **Zalo operations hub** - multi-account, unified inbox, fast reply
- **Customer management layer** - CRM, labels, interaction history, campaigns
- **Automation layer** - workflow, AI, background triggers and actions
- **Business integration layer** - POS, shipping, APIs and external tools
- **Internal management layer** - reports, ERP, permissions, employee workspaces

## âœ¨ Highlights

- ðŸ‘¤ **Multi-account Zalo** - unlimited accounts, quick switching
- ðŸ’¬ **Unified inbox** - merged mode combines conversations from all accounts in one view
- ðŸ‘¥ **CRM & Campaigns** - manage contacts, labels, internal notes, re-engage existing customers; scan hidden group members to find new leads
- âš™ï¸ **Workflow automation** - drag-and-drop Trigger â†’ Node â†’ Action, or use AI to build flows - runs 24/7 without code
- ðŸ¤– **AI Assistant** - reply suggestions, in-chat AI, auto-classify and respond to customers around the clock
- ðŸ”— **External integrations** - POS, shipping, payments, Google Sheets, Telegram, Discord, Email, HTTP Request - usable in chat and workflow
- ðŸ“ˆ **Reports & analytics** - track messages, contacts, labels, employees, campaigns, workflows, AI usage
- ðŸ—‚ï¸ **Internal ERP** - tasks, calendar, notes and team operations in the same system
- ðŸ§‘â€ðŸ’¼ **Boss â†” Employee workspace** - connect over **LAN or WAN** (Cloudflare Tunnel), granular permissions, per-employee performance tracking
- ðŸ”’ **Per-account proxy** - assign an independent HTTP/HTTPS/SOCKS5 proxy to each Zalo account before login
- ðŸ” **Local-first data** - all data stays on the user's machine

### Screenshots

Screens are ordered by typical usage flow: dashboard â†’ chat â†’ CRM â†’ workflow â†’ POS / reports / ERP.

<table>
  <tr>
    <td>
      <img src="./assets/dashboard.png" alt="Multi-account Zalo dashboard in Deplao" width="360" />
      <br />
      <sub><strong>Multi-account dashboard</strong></sub>
    </td>
    <td>
      <img src="./assets/chat.png" alt="Unified chat inbox in Deplao" width="360" />
      <br />
      <sub><strong>Unified inbox with AI</strong></sub>
    </td>
    <td>
      <img src="./assets/crm.png" alt="CRM and contact management in Deplao" width="360" />
      <br />
      <sub><strong>CRM & contacts</strong></sub>
    </td>
  </tr>
  <tr>
    <td>
      <img src="./assets/scan-members-group.png" alt="Scan Zalo group members in Deplao" width="360" />
      <br />
      <sub><strong>Group member scanning</strong></sub>
    </td>
    <td>
      <img src="./assets/campaign.png" alt="Mass messaging campaign in Deplao" width="360" />
      <br />
      <sub><strong>Mass messaging campaigns</strong></sub>
    </td>
    <td>
      <img src="./assets/workflow.png" alt="Drag-and-drop workflow editor in Deplao" width="360" />
      <br />
      <sub><strong>Workflow editor</strong></sub>
    </td>
  </tr>
  <tr>
    <td>
      <img src="./assets/detail-workflow.png" alt="Workflow node configuration in Deplao" width="360" />
      <br />
      <sub><strong>Workflow node detail</strong></sub>
    </td>
    <td>
      <img src="./assets/workflow-ai.png" alt="AI-assisted workflow creation in Deplao" width="360" />
      <br />
      <sub><strong>AI workflow generation</strong></sub>
    </td>
    <td>
      <img src="./assets/pos.png" alt="POS and sales integration in Deplao" width="360" />
      <br />
      <sub><strong>POS, shipping & payments</strong></sub>
    </td>
  </tr>
  <tr>
    <td>
      <img src="./assets/report.jpg" alt="Reports and performance analytics in Deplao" width="360" />
      <br />
      <sub><strong>Reports & analytics</strong></sub>
    </td>
    <td>
      <img src="./assets/report-employee.png" alt="Employee performance report in Deplao" width="360" />
      <br />
      <sub><strong>Employee reports</strong></sub>
    </td>
    <td>
      <img src="./assets/erp.png" alt="Internal ERP and team operations in Deplao" width="360" />
      <br />
      <sub><strong>Internal ERP</strong></sub>
    </td>
  </tr>
</table>

## ðŸŽ¯ Who is it for?

- Online shops and sales teams closing deals via Zalo
- SMEs that need multiple staff handling the inbox simultaneously
- Marketing agencies or freelancers managing multiple client accounts
- Spas, clinics, education, F&B - any business that needs recurring customer care
- Teams wanting to combine chat, CRM, workflow, AI and ERP in one desktop app

## ðŸ§© Core feature groups

### 1) Multi-account & unified inbox
- Log in to multiple Zalo accounts via QR Code
- Visual account management dashboard
- Merge accounts into a single unified inbox
- Search by name, nickname, phone number
- Quick filters: unread, unanswered, labels, conversation status
- **Per-account proxy**: assign an independent HTTP/HTTPS/SOCKS5 proxy to each Zalo account before login - fully isolated IPs across accounts

### 2) Full-featured chat
- Send text, images, video, files
- Emoji, stickers, reply, mention members
- Polls, group notes, reminders, contact cards
- Quick messages - save templates and trigger by keyword
- Unlimited message pinning, media and attachment management

### 3) CRM & customer care
- Sync friends, group members and contact profiles
- Store phone, gender, birthday, internal notes
- Create and manage Zalo labels bi-directionally
- Filter contacts by multiple criteria for targeted outreach
- Create campaigns: mass message, add friend, invite to group - with real-time progress

### 4) Workflow automation
- No-code drag-and-drop workflow builder
- AI assistant generates nodes and workflows from plain-text commands (see section 7)
- Triggers: message received, label applied, reaction, cron schedule, group eventsâ€¦
- Actions: send message/image/file, find user, manage group, mute, forward, recallâ€¦
- Integrations: logic, Google Sheets, AI, Telegram, Discord, Email, Notion, HTTP Request
- Execution history for easy inspection and debugging

### 5) Sales integrations
- POS: KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS
- Shipping: GHN, GHTK
- AI Assistant with reply suggestions and in-chat Q&A (see section 7)
- Easy to combine into end-to-end sales and customer care pipelines

### 6) Reports, ERP & employee management
- Reports: messages, contacts, campaigns, workflows, AI, employees
- Internal ERP: Tasks, Calendar, Notes
- Boss â†” employee model with relay server and module-level permissions
- Track work performance per person and per time period

### 7) ðŸ¤– AI Assistant
- Smart reply suggestions in Zalo and Facebook conversations
- Real-time Q&A with AI directly in the chat window
- Create workflows using plain natural language commands - no drag-and-drop needed
- Use AI action nodes in workflows to build 24/7 auto-reply chatbots
- Multi-platform AI support: OpenAI, Claude, Gemini and 9Router (local AI gateway)

## ðŸ”’ Security & data

Deplao prioritizes a local-first architecture:

- All messages, contacts, CRM data, settings and media are stored on the user's machine
- Login via QR Code - no Zalo password stored; cookies are encrypted on-device
- Users can move the storage directory to another drive at any time
- Ideal for teams that require strict internal data control

## ðŸ’» Runtime requirements

- Stable 24/7 internet connection for conversation sync and automation
- Keep the app running continuously when using workflows or managing a team

---

## ðŸ“£ Contact & support

- Bug reports, feature requests, questions: ðŸ‘‰ [Open an issue](https://github.com/babyvibe/deplao-builder/issues)

## ðŸ™ Acknowledgements

Deplao would like to thank the project:
ðŸ‘‰ https://github.com/RFS-ADRENO/zca-js
ðŸ‘‰ https://github.com/m008v/fbchat-v2
Without the contributions and foundation from this project, Deplao would not have been possible.

---

## ðŸ“ License

This project is distributed under the **MIT License**.
See the [LICENSE](LICENSE) file for details.

---
