// Ledgers are configurable (Settings → Ledgers). These are the initial ones.
// LOAN is required by the Loan Store module and cannot be removed.
export const LOAN_LEDGER = 'LOAN';
export const DEFAULT_LEDGERS = [
  { key: 'STATIONARY', label: 'Stationary Ledger', prefix: 'ST' },
  { key: 'TP', label: 'T&P Ledger', prefix: 'TP' },
  { key: 'IT', label: 'IT Ledger', prefix: 'IT' },
  { key: 'SALVAGE', label: 'Salvage Ledger', prefix: 'SV' },
  { key: LOAN_LEDGER, label: 'Loan Store Ledger', prefix: 'LN' },
];

export const ROLES = ['admin', 'storekeeper', 'viewer'];

export const VOUCHER_TYPES = {
  OPENING: 'Opening',
  RECEIPT: 'Receipt',
  ISSUE: 'Issue',
  LOAN_ISSUE: 'Loan Issue',
  LOAN_RETURN: 'Loan Receipt',
  LOAN_IN: 'Loan From Other Source',
};
export const VOUCHER_TYPE_KEYS = Object.keys(VOUCHER_TYPES);

export const DEFAULT_SETTINGS = {
  ledgers: DEFAULT_LEDGERS,
  orgTitle: 'HQ CWE SHILLONG',
  orgSubtitle: 'STORE INVENTORY MANAGEMENT SYSTEM',
  storeName: 'MES General Store',
  station: 'HQ CWE Shillong',
  storeInCharge: 'Store Keeper',
  units: [
    'HQ CWE Shillong / Admin Section',
    'MES Store Subsidiary / Workshop',
    'Unit / Formation / Maint Section',
    'Admin Section',
    'Works Section',
    'Conference Section',
  ],
  sources: ['Unit / Formation', 'HQ CWE Shillong', 'MES Store Subsidiary', 'Supplier / Firm'],
  receiptTypes: ['Purchase', 'Transfer', 'Indigenous', 'Return'],
  issueTypes: ['Issue', 'Transfer Issue', 'BER', 'Survey Off'],
  loanTypes: ['Loan Issue', 'Temporary Issue'],
  otherOffices: [],
  storeTypes: [],
  auditOffices: ['LAO', 'Test Audit', 'CAG', 'Internal Audit'],
  loanStoreTypes: ['Furniture Store', 'T&P Store', 'Other Items'],
  // Orders page drop-downs (kept separate from the store lists).
  procurementModes: ['GeM', 'Local Purchase', 'Limited Tender', 'Open Tender', 'Single Tender', 'Other'],
  orderApprovers: ['Commander', 'CWE', 'GE', 'AGE (I)'],
  orderAccountsOffices: ['PCDA', 'CDA', 'PAO (MES)', 'AO (GE)'],
  orderDemandFrom: [], // filled from Units / Sections when first created
  orderCodeHeads: [], // filled from Code Heads when first created
  orderUoms: [], // filled from Units of Measure when first created
  orderProjectOffices: [], // Office for the "Project contingency" code head — added in Settings
  // Demand page drop-downs.
  demandSubSections: ['Admin', 'Works', 'Accounts', 'Stores', 'B/R', 'E/M', 'MT'],
  demandFrequencies: ['Regular', 'Monthly', 'Quarterly', 'Half Yearly', 'Annual', 'Urgent'],
  demandAuthorities: ['GE', 'AGE (I)', 'AGE (B/R)', 'AGE (E/M)', 'Commander'], // Type of Loan Store on Loan Store Ledger receipts / issues
  dcsTitle: 'DRAFTED COSTED SCHEDULED', // heading of the printed DCS
  // Signature blocks printed at the foot of a DCS (Settings → DCS – Signature Blocks).
  dcsSignatures: [
    { title: 'Store I/C', name: '', designation: '' },
    { title: 'Officer in Charge', name: '', designation: '' },
  ],
  uoms: ['Nos', 'Ream', 'Set', 'Kg', 'Ltr', 'Mtr', 'Pair', 'Box', 'Pkt', 'Roll'],
  codeHeads: [
    { code: '2210', name: 'Office Furniture' },
    { code: '2305', name: 'Stationery' },
    { code: '2401', name: 'Tools & Plant' },
    { code: '2502', name: 'IT Equipment' },
  ],
};
