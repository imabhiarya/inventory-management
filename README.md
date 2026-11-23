# Store Inventory Management System

MERN-stack (MongoDB, Express, React, Node.js) inventory system for an MES store: item master, goods receipt, goods issue, loan store, master ledger, stock-taking reports (MSTB / QSTB / ASTB / BER-SVY OFF), handing/taking over, and backup/restore. All of it sits behind a login with role-based access.

## Features

| Screen | What it does |
|---|---|
| **Login** | Username/password, httpOnly session cookie, 8-hour sessions, brute-force lockout (10 failed attempts / 15 min) |
| **Dashboard** | Module tiles, store details, low-stock alert, outstanding/overdue loans, quick backup |
| **New Stock Entry** | Register items per ledger (codes auto-generated: `ST-`, `TP-`, `IT-`, `SV-`, `LN-`), re-order level, active/inactive. New items start at zero stock |
| **Receipt** | Multi-item goods receipt with code head, rate, ledger page; save & print; edit/cancel with stock reversal |
| **Issue** | Multi-item issue with live available-stock check; valued at weighted average rate; edit/cancel |
| **Loan Store** | Loan issue (with due date) and loan receipt against an outstanding loan (partial returns supported); overdue tracking |
| **Master Ledger** | Per-ledger / per-item register with running balance, opening B/F, totals; Excel / PDF / Print |
| **Reports** | MSTB, QSTB, ASTB, BER/SVY OFF, stock statement, receipt/issue/loan registers, low stock, item-wise balance, ledger transactions, **Handing Taking of All Store** with ledger-wise appendices |
| **Settings** | Header titles, store details, drop-down master lists (stores, units, sources, types, UoMs, code heads), **user management** |
| **Backup & Restore** | Full JSON backup download; restore with confirmation (admin only) |

### Roles

| Role | Can do |
|---|---|
| `admin` | Everything, including users, settings, backup/restore |
| `storekeeper` | Items, receipts, issues, loans (create / edit / cancel), all reports |
| `viewer` | Read-only: all screens and reports, no changes |

### Data integrity

- Every stock movement (receipt, issue, loan, edit, cancel) runs in a **MongoDB transaction**. A voucher either posts completely or not at all.
- Stock can never go negative, today or on any earlier date. An issue dated before the receipt that brought the stock in is refused, as is cancelling, reducing or re-dating a receipt whose goods were already issued.
- Ledger balances are computed from movement history, so back-dated entries slot in correctly.
- The Loan Store keeps its own ledger. Loan Store Ledger items show their Loan Store balance on the Item Master, dashboard, low-stock alerts and store balance reports (MSTB / QSTB / ASTB, stock statement, handing/taking over).
- `npm --prefix server run reconcile` checks the cached balances against the ledgers (dry run); add `-- --apply` to repair any mismatch. It writes a backup to `.data/` first.
- Cancelled vouchers stay on record (with reason, user and time). An audit log records every change.

## Project layout

```
server/            Express API (Node 20+)
  src/routes/      auth, users, settings, items, receipts, issues, loans, ledger, reports, dashboard, backup
  src/services/    stock posting (transactions), report aggregation
  scripts/         create-admin.js, seed-demo.js
  tests/           API integration tests (in-memory MongoDB replica set)
client/            React + Vite single-page app
  public/          logo-left.svg, logo-right.svg  ← replace with your emblems
desktop/           Electron shell for the Windows desktop app (see below)
Dockerfile, docker-compose.yml
```

## Requirements

- Node.js 20 or later (tested on 24)
- MongoDB 6+ running as a **replica set**. A single node is fine. Transactions need a replica set; the server refuses to start against a standalone server.

## Local development

```bash
# 1. MongoDB as a single-node replica set (one-time init)
mongod --replSet rs0 --dbpath ~/mongo-data
mongosh --eval 'rs.initiate()'

# 2. Install
npm run install:all

# 3. Configure
cp server/.env.example server/.env
#    set JWT_SECRET; for local http testing set COOKIE_SECURE=false and NODE_ENV=development

# 4. First admin user (prompts for password)
npm --prefix server run create-admin

# 5. (optional) demo data matching the prototype screens, into an empty database only
npm --prefix server run seed:demo

# 6. Run: API on :5000, UI on :5173 (proxies /api to the API)
npm run dev:server
npm run dev:client
```

On macOS, port 5000 is used by AirPlay Receiver. Set `PORT=5050` in `server/.env` and start the UI with `API_PORT=5050 npm run dev:client`.

## Production deployment

### Option A: Docker Compose (recommended)

```bash
cp .env.example .env          # set JWT_SECRET (48+ random chars)
docker compose up -d --build
docker compose exec app node scripts/create-admin.js
```

The app listens on port 5000 and serves both the API and the built UI from one origin. Put it behind HTTPS (nginx, Caddy, or your organisation's reverse proxy) and set `TRUST_PROXY=1`. The session cookie is `Secure`, so **plain HTTP will not keep users signed in** unless you set `COOKIE_SECURE=false`. Only do that on an isolated LAN.

### Option B: Plain Node

```bash
npm run install:all && npm run build
cd server && NODE_ENV=production node src/index.js     # or run under pm2 / systemd
```

### Checklist

- [ ] Strong unique `JWT_SECRET`; `.env` not committed
- [ ] HTTPS in front of the app; `TRUST_PROXY` set if behind a proxy
- [ ] MongoDB not exposed publicly; enable MongoDB authentication and add credentials to `MONGODB_URI`
- [ ] Scheduled database backups (`mongodump`) in addition to the in-app JSON backup
- [ ] Run `npm --prefix server run reconcile` after any manual database change or restore from an old backup
- [ ] Replace `client/public/logo-left.svg` and `logo-right.svg` with your official emblems, then rebuild
- [ ] Set store details and master lists under **Settings**; create user accounts for each person

## Windows desktop app

The `desktop/` folder wraps the same server and UI in an [Electron](https://www.electronjs.org/) app that runs entirely on one Windows PC. No separate Node.js or MongoDB install is needed.

How it works:

- The app ships its own `mongod.exe` (MongoDB Community 8.0) and starts it as a private single-node replica set on `127.0.0.1:27217`.
- It then starts the Express server inside Electron on `127.0.0.1:47815`, and opens a window on it. Both listen on this PC only, not the network.
- The database, logs and a generated `JWT_SECRET` live in `%APPDATA%\Store Inventory Management System\` (**File → Open Data Folder**). Uninstalling the app keeps this folder.
- On the first start, the app asks you to create the administrator account.
- To move data across from the web version, take a backup there (**Backup & Restore**) and restore it in the desktop app.
- If a preferred port is busy, the app picks a free one and remembers it.

### Moving to a new PC (old PC failed)

1. On the old PC, regularly use **Backup & Restore → Download Backup (JSON)** and keep the file off that PC (pen drive, another computer). The file holds everything: items, vouchers, ledgers, settings, audit attachments and user accounts.
2. Install the app on the new PC. On its first start, under **Moving from an old computer?**, click **Choose backup file…**, pick the file and click **Restore this backup and continue**.
3. Sign in with the same username and password as on the old PC. No internet is needed.

The Backup & Restore page also offers **Download Backup (Excel)**: one sheet per register, viewable in Excel, and restorable from the same page (its Choose backup file… takes `.json` or `.xlsx`). The new-PC first-run screen takes the JSON file only.

From the command line the same restore is `BACKUP_FILE=path/to/backup.json npm --prefix server run restore-backup` (it replaces all data in `MONGODB_URI`).

### Online sync (MongoDB Atlas)

The desktop app always saves to the database on the PC, so it works the same with or without internet. With **Online Sync → Sync Settings…** turned on, it also keeps a copy of all data in a MongoDB Atlas database:

- Every change (new entries, edits, cancellations, deletions) is uploaded in the background within seconds. The window title shows the status: up to date, uploading, or offline.
- Without internet, entries are saved on the PC as usual. When the connection returns, everything left over is uploaded automatically, even if the app was closed and reopened in between.
- **No duplicates:** each record is written online under its own ID, replacing the previous version. Uploading the same change twice simply overwrites it with identical data. The app remembers how far it has uploaded, and only marks a change as done once Atlas has accepted it.
- If the app can't tell exactly what is missing (for example, after a very long time offline), it re-copies everything and removes from the online copy anything the PC no longer has.
- The online database is a **copy of this one PC**. It refuses to sync with a database that already contains other data or belongs to another computer. Don't make entries in it directly: the PC's data always wins.

Set-up in Atlas:

1. Create a cluster (the free M0 tier is enough for a small store; it holds 512 MB).
2. Under **Database Access**, add a database user with read/write access.
3. Under **Network Access**, allow the PC's IP address. Use `0.0.0.0/0` if the PC's address changes, as it usually does on home or mobile internet; the password still protects the database.
4. **Connect → Drivers** gives the `mongodb+srv://…` connection string. Paste it in the app with your password filled in, choose a new database name, then **Test connection** and **Save and turn on**.

The connection string is stored encrypted with Windows' own protection (DPAPI), under the Windows user account. Errors are written to `logs\sync.log`.

### Build the installer

Build on Windows 10/11 x64 (or a Mac/Linux machine that can run Intel binaries; on Apple Silicon install Rosetta first with `softwareupdate --install-rosetta`):

```bash
npm run install:all
npm run desktop:install
npm run desktop:dist:win
```

This produces `desktop/release/Store-Inventory-Setup-1.0.0.exe`. The build:

1. builds the React client and stages a production copy of the server in `desktop/build/`
2. downloads `mongod.exe` (only that file, about 80 MB, read straight out of MongoDB's official zip and checked against its CRC) and Microsoft's `vc_redist.x64.exe` into `desktop/vendor/`
3. packages everything with electron-builder. The installer installs the Visual C++ runtime that `mongod.exe` needs if the PC doesn't have it

Notes:

- The installer is not code-signed, so Windows SmartScreen will warn on first run (**More info → Run anyway**). Sign it with a code-signing certificate for wider distribution.
- Add `desktop/build-resources/icon.ico` (256×256) to replace the default Electron icon.
- Requires Windows 10 or later, 64-bit (MongoDB 8.0's minimum).
- Pick a different MongoDB version with `MONGODB_VERSION=8.0.x npm --prefix desktop run fetch:vendor`. Delete `desktop/vendor/mongodb` first.

### Run it in development

```bash
npm run desktop:start
```

This builds the client and opens the app with data in a separate `Store Inventory Management System (dev)` folder. It uses `desktop/vendor/mongodb/<platform>/mongod` if present, otherwise `MONGOD_PATH` or `mongod` on your `PATH`. Set `MES_STORE_DATA_DIR` to use a different data folder.

## Tests

```bash
npm test
# Uses an in-memory MongoDB replica set. To use a locally installed mongod instead of downloading one:
MONGOMS_SYSTEM_BINARY=$(which mongod) npm test
```

## Notes on business rules

- **Financial year:** April to March (Indian FY). Quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
- **Dates:** "today" is computed in IST. Voucher dates cannot be in the future.
- **Valuation:** a receipt updates the item's weighted average rate; an issue is valued at that rate.
- **Opening stock:** items are registered with zero stock. Bring existing stock in with a Receipt (e.g. type *Transfer*, dated the start of the financial year).
- **Loan store:** only items registered in the *Loan Store Ledger* can be loaned. A loan receipt must reference the loan issue it returns against.
- **Items with transactions** cannot be deleted. Set them to Inactive instead.
