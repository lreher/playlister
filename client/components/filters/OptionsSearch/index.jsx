// Free-text search backed by a native datalist, constrained to a known set
// of values — the datalist-driven counterpart to OptionsSelect. Uncontrolled
// (remounted via `resetKey`, not driven by a value prop) — the backend
// filter is exact-match, so typing has to be unconstrained while the user
// is mid-value; forcing a value prop onto it would fight that.
import { useId } from 'preact/hooks';

export function OptionsSearch({ options, placeholder, onChange, resetKey }) {
  const optionSet = new Set(options);
  const listId = useId();

  return (
    <>
      {/* Fires both when typing a full exact value and when picking a
          native datalist suggestion. Only applies the change once the typed
          value is empty (clear) or matches a known option — avoids firing a
          request per keystroke on a still-partial value. */}
      <input
        key={resetKey}
        type="text"
        className="filter-search-input"
        placeholder={placeholder}
        list={listId}
        onInput={(e) => {
          const value = e.target.value;
          if (value === '' || optionSet.has(value)) onChange(value);
        }}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </>
  );
}
