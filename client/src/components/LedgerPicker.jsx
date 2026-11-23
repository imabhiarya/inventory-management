import { useApp } from '../context/AppContext.jsx';
import { Select } from './ui.jsx';

/**
 * "Type of Store / Ledger" picker. Lists top-level ledgers; when a group ledger (e.g. Maint Store) is chosen,
 * a second dropdown appears below with its sub-ledgers (e.g. B&R / E&M Store Ledger). `value` / `onChange`
 * always carry a usable ledger key — a sub-ledger, never the group itself.
 */
export default function LedgerPicker({ value, onChange, className = 'input highlight', disabled, title }) {
  const { meta } = useApp();
  const all = meta.allLedgers || meta.ledgers;
  const groups = meta.ledgerGroups || [];
  const groupOf = (key) => groups.find((g) => g.children.includes(key));
  const topLevel = all.filter((l) => !l.parent);
  const current = all.find((l) => l.key === value);
  const group = groupOf(value);
  const topValue = group ? group.key : value;

  const chooseTop = (key) => {
    const g = groups.find((x) => x.key === key);
    onChange(g ? g.children[0] : key); // a group starts on its first sub-ledger
  };

  return (
    <div className="ledger-picker">
      <Select
        className={className}
        value={topValue}
        onChange={chooseTop}
        options={topLevel.map((l) => ({ value: l.key, label: l.label }))}
        disabled={disabled}
        title={title}
      />
      {group && (
        <Select
          className={`${className} ledger-sub`}
          value={current?.key}
          onChange={onChange}
          options={group.children.map((k) => ({ value: k, label: all.find((l) => l.key === k)?.label || k }))}
          disabled={disabled}
          title={title}
          aria-label={`${group.label} – sub-ledger`}
        />
      )}
    </div>
  );
}
