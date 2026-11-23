import { useMemo, useState } from "react";
import {
  BookOpen,
  PencilRuler,
  Wrench,
  Monitor,
  Recycle,
  Boxes,
  Search,
  FolderOpen,
  Pencil,
  PenLine,
  Ruler,
  Paperclip,
  NotebookPen,
  Scissors,
  Hammer,
  Drill,
  Cog,
  Shovel,
  Laptop,
  Keyboard,
  Mouse,
  Printer,
  Cpu,
  Trash2,
  Truck,
  Battery,
  Package,
  Handshake,
  ArrowLeftRight,
  Container,
  Construction,
  Zap,
  BrickWall,
  Plug,
  PaintRoller,
  Lightbulb,
  FileSpreadsheet,
} from "lucide-react";
import ItemImportModal from "../components/ItemImportModal.jsx";
import { useApp } from "../context/AppContext.jsx";
import { useFetch } from "../hooks.js";
import {
  PageHeader,
  Panel,
  Field,
  Select,
  ExportButtons,
  LedgerPrintHeader,
} from "../components/ui.jsx";
import { fmtDate, fmtQty, fyStart } from "../utils/format.js";
import { LoanLedger } from "./LoanStore.jsx";

// Icons for the built-in ledgers; ledgers added in Settings get a generic icon and a rotating colour.
// `items`: faded pictures of that ledger's typical items, scattered behind the tile.
const TILE_STYLE = {
  STATIONARY: { icon: PencilRuler, color: "blue", items: [Pencil, Ruler, Paperclip, NotebookPen, Scissors, PenLine] },
  TP: { icon: Wrench, color: "green", items: [Hammer, Wrench, Drill, Cog, Shovel, Hammer] },
  IT: { icon: Monitor, color: "sky", items: [Monitor, Laptop, Keyboard, Mouse, Printer, Cpu] },
  SALVAGE: { icon: Recycle, color: "orange", items: [Recycle, Trash2, Boxes, Truck, Battery, Recycle] },
  LOAN: { icon: Boxes, color: "purple", items: [Package, Handshake, ArrowLeftRight, Container, Boxes, Package] },
  MAINT_STORE: { icon: Construction, color: "violet", items: [BrickWall, Zap, Hammer, Plug, PaintRoller, Lightbulb] },
};
const EXTRA_COLORS = ["violet", "green", "blue", "orange", "sky", "purple"];
export const ledgerTiles = (ledgers) =>
  ledgers.map((l, i) => ({
    key: l.key,
    label: l.label.replace(/\s*ledger$/i, ""),
    ...(TILE_STYLE[l.key] || {
      icon: FolderOpen,
      color: EXTRA_COLORS[i % EXTRA_COLORS.length],
    }),
  }));

// Register columns from the voucher: Old RV No. (Old IV No. on issues), PO / sanction no. & date, Source / Issued To.
const oldNoOf = (r) => r.oldRvNo || (r.oldLedgerPage ? `Old Ledger Pg ${r.oldLedgerPage}` : "") || (r.oldIvNo ? `IV ${r.oldIvNo}` : "");
const poOf = (r) => (r.poNo ? `${r.poNo}${r.poDate ? ` · ${fmtDate(r.poDate)}` : ""}` : "");
const partyOf = (r) => r.source || (r.issueTo ? `To: ${r.issueTo}` : "");

const HOLDING_OPTIONS = [
  { value: "ALL", label: "All Items" },
  { value: "HELD", label: "Bal Qty Items" },
  { value: "ZERO", label: "0 Holding Qty Items" },
];

const VOUCHER_TYPES = [
  { value: "OPENING", label: "Opening" },
  { value: "RECEIPT", label: "Receipt" },
  { value: "ISSUE", label: "Issue" },
  { value: "LOAN_ISSUE", label: "Loan Issue" },
  { value: "LOAN_RETURN", label: "Loan Receipt" },
  { value: "LOAN_IN", label: "Loan From Other Source" },
];

export default function MasterLedger() {
  const { meta, settings, ledgerLabel } = useApp();
  const [ledger, setLedger] = useState("STATIONARY");
  const [f, setF] = useState({
    from: fyStart(meta.currentFy),
    to: meta.today,
    item: "",
    voucherType: "",
    holding: "ALL",
  });
  const [applied, setApplied] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const { data: itemsData, reload: reloadItems } = useFetch("/items", { ledger });
  const items = useMemo(() => itemsData?.items || [], [itemsData]);
  // Items that have a Ledger Page No., in page order (numeric where possible).
  const pagedItems = useMemo(
    () =>
      items
        .filter((i) => i.ledgerPage)
        .sort((a, b) => a.ledgerPage.localeCompare(b.ledgerPage, undefined, { numeric: true })),
    [items],
  );
  const { data: fetched, loading, error: fetchError, reload: reloadLedger } = useFetch("/ledger", applied, {
    enabled: !!applied,
  });
  // Show results only for the ledger/filters currently applied: after switching ledger (or sub-ledger tab)
  // the previous ledger's rows must not stay on screen until View Report is clicked again.
  const data = applied ? fetched : null;
  const error = applied ? fetchError : null;

  // Opening a ledger (tile or sub-ledger tab) shows its register at once for the chosen dates.
  const chooseLedger = (key) => {
    const next = { ...f, item: "" };
    setLedger(key);
    setF(next);
    setApplied({ ledger: key, ...next });
  };
  // Tiles show top-level ledgers; a group (e.g. Maint Store) opens tabs for its sub-ledgers.
  const allLedgers = meta.allLedgers || meta.ledgers;
  const groups = meta.ledgerGroups || [];
  const group = groups.find((g) => g.children.includes(ledger));
  const topLevel = allLedgers.filter((l) => !l.parent);
  const rows = data?.rows || [];
  // Print leaves out "Nil" lines (items with no entries) unless the user asked for 0 Holding Qty items;
  // printed Sl. numbers count only the printed lines.
  const printNil = applied?.holding === "ZERO";
  let printed = 0;
  const printSl = rows.map((r) => (r.voucherType === "Nil" && !printNil ? null : ++printed));
  // Period shown on exports: blank dates mean "from the first entry" / "up to today".
  const periodText = applied
    ? `${applied.from ? fmtDate(applied.from) : "From first entry"} to ${fmtDate(data?.to || applied.to) || "today"}`
    : "";
  const holdingText = applied && applied.holding !== "ALL" ? ` · ${HOLDING_OPTIONS.find((o) => o.value === applied.holding)?.label}` : "";
  const title = `${ledgerLabel(ledger)} – Register (${settings.storeName})`;

  const columns = [
    { key: "sl", label: "Sl.", value: (r) => rows.indexOf(r) + 1 },
    { key: "date", label: "Date", format: fmtDate },
    { key: "voucherType", label: "Vouch. Type" },
    {
      key: "voucherNo",
      label: "Vouch. No.",
      value: (r) => r.voucherNo,
    },
    { key: "oldNo", label: "Old RV No.", value: oldNoOf },
    { key: "po", label: "PO / Sanction No. & Date", value: poOf, width: 24 },
    { key: "party", label: "Source / Issued To", value: partyOf, width: 26 },
    // Item name with its description (Item Master) — also on Excel / PDF.
    { key: "item", label: "Item Name", value: (r) => (r.item?.description ? `${r.item.name} – ${r.item.description}` : r.item?.name), width: 40 },
    { key: "ledgerPage", label: "Ledger Pg", value: (r) => r.item?.ledgerPage || "" },
    { key: "uom", label: "UoM", value: (r) => r.item?.uom },
    {
      key: "receiptQty",
      label: "Receipt Qty",
      align: "right",
      numeric: true,
      format: (v) => (v ? fmtQty(v) : "-"),
    },
    {
      key: "issueQty",
      label: "Issue Qty",
      align: "right",
      numeric: true,
      format: (v) => (v ? fmtQty(v) : "-"),
    },
    {
      key: "balance",
      label: "Balance Qty",
      align: "right",
      numeric: true,
      format: fmtQty,
    },
    { key: "remarks", label: "Remarks", width: 34 },
  ];

  return (
    <>
      <PageHeader
        icon={BookOpen}
        plainIcon
        title="Master Ledger"
        extra={
          <button type="button" className="btn btn-green" onClick={() => setImportOpen(true)} title="Import items from a file, or export them to Excel">
            <FileSpreadsheet size={18} /> Import / Export Items
          </button>
        }
      />
      {importOpen && (
        <ItemImportModal
          ledger={ledger}
          onClose={(changed) => {
            setImportOpen(false);
            if (changed) {
              reloadItems();
              if (applied) reloadLedger();
            }
          }}
        />
      )}
      <div className="tiles small">
        {ledgerTiles(topLevel).map(({ key, label, icon: Icon, color, items }) => (
          <button
            key={key}
            type="button"
            className={`tile ledger-tile ${color} ${ledger === key || group?.key === key ? "selected" : ""}`}
            onClick={() => {
              const g = groups.find((x) => x.key === key);
              chooseLedger(g ? g.children[0] : key);
            }}
          >
            {items && (
              <span className="lt-items" aria-hidden="true">
                {items.map((Item, i) => (
                  <Item key={i} className={`lt-item p${i}`} strokeWidth={1.6} />
                ))}
              </span>
            )}
            <Icon strokeWidth={1.8} />
            <span>
              {label}
              <br />
              <small>Ledger</small>
            </span>
          </button>
        ))}
      </div>

      {group && (
        <div className="subledger-tabs" role="tablist" aria-label={`${group.label} – sub-ledgers`}>
          <span className="subledger-of">{group.label.replace(/\s*ledger$/i, "")}:</span>
          {group.children.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={ledger === k}
              className={`subledger-tab ${ledger === k ? "active" : ""}`}
              onClick={() => chooseLedger(k)}
            >
              <BookOpen size={16} /> {ledgerLabel(k)}
            </button>
          ))}
        </div>
      )}

      {/* The Loan Store keeps its own ledger (same view as the Loan Store → Loan Store Ledger tab). */}
      {ledger === "LOAN" ? (
        <LoanLedger />
      ) : (
        <Panel title={title} icon={BookOpen} id="ledger-print" className="ledger-report">
          <div className="no-print">
            <form
              className="filters"
              onSubmit={(e) => {
                e.preventDefault();
                setApplied({ ledger, ...f });
              }}
            >
              <Field label="From Date" stack>
                <input
                  className="input"
                  type="date"
                  value={f.from}
                  onChange={(e) => setF({ ...f, from: e.target.value })}
                  title="Optional – leave blank to start from the first entry"
                />
              </Field>
              <Field label="To Date" stack>
                <input
                  className="input"
                  type="date"
                  value={f.to}
                  onChange={(e) => setF({ ...f, to: e.target.value })}
                  title="Optional – leave blank for up to today"
                />
              </Field>
              <div className="field stack grow">
                <label>Item Name</label>
                <Select
                  value={f.item}
                  onChange={(v) => setF({ ...f, item: v })}
                  placeholder="All Items"
                  options={items.map((i) => ({
                    value: i._id,
                    label: `${i.code} – ${i.name}`,
                  }))}
                />
              </div>
              {/* Ledger Page: pick an item by its page in the ledger (same item filter, page-wise). */}
              <Field label="Ledger Page" stack>
                <Select
                  value={pagedItems.some((i) => i._id === f.item) ? f.item : ""}
                  onChange={(v) => setF({ ...f, item: v })}
                  placeholder="All Pages"
                  options={pagedItems.map((i) => ({
                    value: i._id,
                    label: `Pg ${i.ledgerPage} – ${i.name}`,
                  }))}
                />
              </Field>
              <Field label="Vouch. Type" stack>
                <Select
                  value={f.voucherType}
                  onChange={(v) => setF({ ...f, voucherType: v })}
                  placeholder="All"
                  options={VOUCHER_TYPES}
                />
              </Field>
              {/* Which items to list: all, only those still holding stock, or those holding nothing. */}
              <Field label="Stock" stack>
                <Select
                  value={f.holding}
                  onChange={(v) => setF({ ...f, holding: v })}
                  options={HOLDING_OPTIONS}
                />
              </Field>
              <button className="btn btn-blue">
                <Search size={18} /> View Report
              </button>
              <span
                style={{ borderLeft: "2px solid var(--border)", height: 36 }}
              />
              <ExportButtons
                orientable
                printId="ledger-print"
                disabled={!rows.length}
                getExport={() => ({
                  title,
                  subtitle: `${periodText}${holdingText}${data?.summary ? ` · Item: ${data.summary.item.name} (${data.summary.item.uom})` : ""}`,
                  columns,
                  rows,
                  filename: `ledger-${ledger.toLowerCase()}-${applied.from || "start"}-${data?.to?.slice(0, 10) || applied.to}`,
                })}
              />
            </form>
          </div>
          <div className="print-doc">
            <LedgerPrintHeader
              ledger={ledgerLabel(ledger)}
              asOn={data?.to ? fmtDate(data.to) : applied?.to ? fmtDate(applied.to) : ""}
            />
          </div>

          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Sl.</th>
                  <th>Date</th>
                  <th>Vouch. Type</th>
                  <th>Vouch. No.</th>
                  <th>Old RV No.</th>
                  <th>PO / Sanction No. &amp; Date</th>
                  <th>Source / Issued To</th>
                  <th>Item Name</th>
                  <th>Ledger Pg</th>
                  <th>UoM</th>
                  <th className="num">Receipt Qty</th>
                  <th className="num">Issue Qty</th>
                  <th className="num">Balance Qty</th>
                  <th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r._id || `o-${i}`}
                    className={[
                      i > 0 && rows[i - 1].item?._id !== r.item?._id ? "item-start" : "",
                      r.voucherType === "Nil" ? "nil-row" : "",
                      printSl[i] === null ? "no-print-row" : "",
                    ].join(" ")}
                  >
                    <td className="center">
                      <span className="sl-screen">{i + 1}</span>
                      <span className="sl-print">{printSl[i]}</span>
                    </td>
                    <td className="center">{fmtDate(r.date)}</td>
                    <td className="center">{r.voucherType}</td>
                    <td className="center">{r.voucherNo}</td>
                    <td className="center">{oldNoOf(r) || "-"}</td>
                    <td className="center">
                      {r.poNo ? (
                        <>
                          {r.poNo}
                          {r.poDate && <div className="item-desc">{fmtDate(r.poDate)}</div>}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>{partyOf(r) || "-"}</td>
                    <td>
                      {r.item?.name}
                      {r.item?.description && <div className="item-desc">{r.item.description}</div>}
                    </td>
                    <td className="center">{r.item?.ledgerPage || "-"}</td>
                    <td className="center">{r.item?.uom}</td>
                    <td className="num">
                      {r.receiptQty ? fmtQty(r.receiptQty) : "-"}
                    </td>
                    <td className="num">
                      {r.issueQty ? fmtQty(r.issueQty) : "-"}
                    </td>
                    <td className="num">
                      <b>{fmtQty(r.balance)}</b>
                    </td>
                    <td>{r.remarks}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={14} className="empty">
                      {error ? (
                        <span className="error-text">{error.message}</span>
                      ) : loading ? (
                        "Loading…"
                      ) : applied ? (
                        "No entries in this period."
                      ) : (
                        "Choose filters and click View Report."
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data?.summary && (
            <div className="summary-bar" style={{ marginTop: 14 }}>
              <div className="info">
                <Boxes size={26} /> Item : {data.summary.item.name}{" "}
                <span className="muted">|</span> UoM : {data.summary.item.uom}
                {data.summary.item.ledgerPage && (
                  <>
                    {" "}
                    <span className="muted">|</span> Ledger Pg : {data.summary.item.ledgerPage}
                  </>
                )}
              </div>
              <div className="stat blue">
                Opening Qty <b>{fmtQty(data.summary.openingQty)}</b>
              </div>
              <div className="stat green">
                Total Receipt Qty <b>{fmtQty(data.summary.totalReceipt)}</b>
              </div>
              <div className="stat orange">
                Total Issue Qty <b>{fmtQty(data.summary.totalIssue)}</b>
              </div>
              <div className="stat blue">
                Closing Balance Qty <b>{fmtQty(data.summary.closingQty)}</b>
              </div>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
