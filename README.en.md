# Deplao

<p>
  <strong>🌐 Language:</strong>
  &nbsp;🇻🇳 <a href="./README.md">Tiếng Việt</a>
  &nbsp;|&nbsp;
  🇬🇧 <strong>English</strong>
</p>

---

> A multi-account Zalo desktop app with integrated CRM, ERP, POS, Workflow automation and AI Assistant — helping sales and customer care teams operate centrally in one single application.

[![Version](https://img.shields.io/badge/version-26.4.0-22c55e)](#-changelog-v2640)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-3b82f6)](#-system-requirements)
[![Support](https://img.shields.io/badge/support-GitHub-0ea5e9)](https://github.com/babyvibe/deplao-builder/issues)

<p align="center">
  <img src="./assets/deplao-overview-map.svg" alt="Deplao — centralized desktop workspace for Zalo sales and customer care" width="960" />
</p>

## 🛠️ Tech Stack

- **Core library:** zca-js — https://github.com/RFS-ADRENO/zca-js
- **Languages:** TypeScript, JavaScript, SQL, HTML, CSS
- **Desktop:** Electron, React, Vite
- **UI:** Tailwind CSS, PostCSS, React Router
- **Local storage:** SQLite via `better-sqlite3`
- **State & UI:** Zustand, React Flow, Recharts, Quill
- **Backend services:** Node.js + Express
- **Integrations & automation:** Axios, Google APIs / Sheets, node-cron, Discord.js, Telegram Bot API, OpenAI API, etc.

---

### 4️⃣ Multi-account & Local Storage

```mermaid
flowchart LR
    subgraph ACCS["👤 Accounts"]
        Z1("Zalo #1\nzca-js")
        Z2("Zalo #2\nzca-js")
        ZN("Zalo #N\nzca-js")
        FB("Facebook\nGraph API")
    end

    subgraph STORE["💾 Local Storage"]
        DB[("🗄️ SQLite\ndeplao-tool.db\nmessages · contacts\ncrm · workflow · erp")]
        MED("📁 FileStorage\n~/media/\nimages · videos · files")
        ES("🔑 electron-store\ncookies · tokens\nsettings")
    end

    subgraph WS["🗂️ Workspace Manager"]
        WA("🏠 Local WS\nDefault")
        WB("🌐 Remote WS\nBoss")
        WC("⚙️ Custom WS\ncustom path")
    end

    Z1 & Z2 & ZN & FB -->|"messages · contacts"| DB
    Z1 & Z2 & ZN & FB -->|"images · videos · files"| MED
    ES -->|"cookie session"| Z1 & Z2 & ZN
    DB & ES <-->|"path resolve\nswitch workspace"| WS
    WA & WB & WC -.-|"each WS = own DB"| DB
```

> Each **Workspace** has its own independent DB + media folder.
> You can move the data directory to another drive without losing any data.

---

# Installation

<details open>
<summary>Build from source</summary>

## Requirements

- Windows 10/11 or macOS
- Node.js 18+ recommended
- npm 9+

## Install dependencies

```powershell
npm install --legacy-peer-deps
```

## Run in development mode

```powershell
npm run build:dev
```

## Build production app

```powershell
npm run build:production
```

## Local data

- App data uses local SQLite
- Storage directory can be changed in `Settings`

</details>

<details>
<summary>Download pre-built release</summary>

Deplao supports multiple operating systems. Download the right version from the Releases page:

👉 https://github.com/babyvibe/deplao-builder/releases

---

### 🖥️ Choose the right build:

- 🪟 **Windows** — download `*.exe`
- 🍎 **macOS (Apple Silicon — M1/M2/M3/M4/M5)** — download `*-arm64.dmg`
- 🍎 **macOS (Intel)** — download `*.dmg`

💡 Always pick the latest release (top of the list).

---

## ⚠️ Security warning on first launch

Deplao is not code-signed (we're bootstrapped), so your OS may show a warning.

### 🪟 Windows — "Windows protected your PC"

1. Click **More info**
2. Click **Run anyway**

### 🍎 macOS — "cannot be opened because it is from an unidentified developer"

**Option 1:**
- Right-click the `.dmg` → **Open** → **Open** again

**Option 2 (if still blocked):**
1. Go to **System Settings → Privacy & Security**
2. Scroll to Security
3. Click **Open Anyway**

</details>

## 🚀 What is Deplao?

At a glance, Deplao is:

- **Zalo operations hub** — multi-account, unified inbox, fast reply
- **Customer management layer** — CRM, labels, interaction history, campaigns
- **Automation layer** — workflow, AI, background triggers and actions
- **Business integration layer** — POS, shipping, APIs and external tools
- **Internal management layer** — reports, ERP, permissions, employee workspaces

## ✨ Highlights

- 👤 **Multi-account Zalo** — unlimited accounts, quick switching
- 💬 **Unified inbox** — merged mode combines conversations from all accounts in one view
- 👥 **CRM & Campaigns** — manage contacts, labels, internal notes, re-engage existing customers; scan hidden group members to find new leads
- ⚙️ **Workflow automation** — drag-and-drop Trigger → Node → Action, or use AI to build flows — runs 24/7 without code
- 🤖 **AI Assistant** — reply suggestions, in-chat AI, auto-classify and respond to customers around the clock
- 🔗 **External integrations** — POS, shipping, payments, Google Sheets, Telegram, Discord, Email, HTTP Request — usable in chat and workflow
- 📈 **Reports & analytics** — track messages, contacts, labels, employees, campaigns, workflows, AI usage
- 🗂️ **Internal ERP** — tasks, calendar, notes and team operations in the same system
- 🧑‍💼 **Boss ↔ Employee workspace** — multiple devices manage one account, granular permissions, per-employee performance tracking
- 🔒 **Local-first data** — all data stays on the user's machine

### Screenshots

Screens are ordered by typical usage flow: dashboard → chat → CRM → workflow → POS / reports / ERP.

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
      <sub><strong>Unified inbox</strong></sub>
    </td>
    <td>
      <img src="./assets/crm.png" alt="CRM and contact management in Deplao" width="360" />
      <br />
      <sub><strong>CRM & contacts</strong></sub>
    </td>
  </tr>
  <tr>
    <td>
      <img src="./assets/workflow.png" alt="Drag-and-drop workflow editor in Deplao" width="360" />
      <br />
      <sub><strong>Workflow editor</strong></sub>
    </td>
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
  </tr>
  <tr>
    <td>
      <img src="./assets/pos.png" alt="POS and sales integration in Deplao" width="360" />
      <br />
      <sub><strong>POS, shipping & payments</strong></sub>
    </td>
    <td>
      <img src="./assets/report.jpg" alt="Reports and performance analytics in Deplao" width="360" />
      <br />
      <sub><strong>Reports & analytics</strong></sub>
    </td>
    <td>
      <img src="./assets/erp.png" alt="Internal ERP and team operations in Deplao" width="360" />
      <br />
      <sub><strong>Internal ERP</strong></sub>
    </td>
  </tr>
</table>

## 🎯 Who is it for?

- Online shops and sales teams closing deals via Zalo
- SMEs that need multiple staff handling the inbox simultaneously
- Marketing agencies or freelancers managing multiple client accounts
- Spas, clinics, education, F&B — any business that needs recurring customer care
- Teams wanting to combine chat, CRM, workflow, AI and ERP in one desktop app

## 🧩 Core feature groups

### 1) Multi-account & unified inbox
- Log in to multiple Zalo accounts via QR Code
- Visual account management dashboard
- Merge accounts into a single unified inbox
- Search by name, nickname, phone number
- Quick filters: unread, unanswered, labels, conversation status

### 2) Full-featured chat
- Send text, images, video, files
- Emoji, stickers, reply, mention members
- Polls, group notes, reminders, contact cards
- Quick messages — save templates and trigger by keyword
- Unlimited message pinning, media and attachment management

### 3) CRM & customer care
- Sync friends, group members and contact profiles
- Store phone, gender, birthday, internal notes
- Create and manage Zalo labels bi-directionally
- Filter contacts by multiple criteria for targeted outreach
- Create campaigns: mass message, add friend, invite to group — with real-time progress

### 4) Workflow automation
- No-code drag-and-drop workflow builder
- AI assistant generates nodes from a plain-text prompt
- Triggers: message received, label applied, reaction, cron schedule, group events…
- Actions: send message/image/file, find user, manage group, mute, forward, recall…
- Integrations: logic, Google Sheets, AI, Telegram, Discord, Email, Notion, HTTP Request
- Execution history for easy inspection and debugging

### 5) Sales integrations
- POS: KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS
- Shipping: GHN, GHTK
- AI Assistant for reply suggestions and quick in-chat responses
- Easy to combine into end-to-end sales and customer care pipelines

### 6) Reports, ERP & employee management
- Reports: messages, contacts, campaigns, workflows, AI, employees
- Internal ERP: Tasks, Calendar, Notes
- Boss ↔ employee model with relay server and module-level permissions
- Track work performance per person and per time period

## 🔒 Security & data

Deplao prioritizes a local-first architecture:

- All messages, contacts, CRM data, settings and media are stored on the user's machine
- Login via QR Code — no Zalo password stored; cookies are encrypted on-device
- Users can move the storage directory to another drive at any time
- Ideal for teams that require strict internal data control

## 💻 Runtime requirements

- Stable 24/7 internet connection for conversation sync and automation
- Keep the app running continuously when using workflows or managing a team

---

## 📣 Contact & support

- Bug reports, feature requests, questions: 👉 [Open an issue](https://github.com/babyvibe/deplao-builder/issues)

## 🙏 Acknowledgements

Deplao would like to thank the project:
👉 https://github.com/RFS-ADRENO/zca-js

Without the contributions and foundation from this project, Deplao would not have been possible.

We deeply appreciate the value the open-source community brings 💙

---

