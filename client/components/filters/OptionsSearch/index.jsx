// Uncontrolled (remounted via resetKey) since the backend filter is exact-match —
// typing has to stay unconstrained mid-value.
import { useId } from 'preact/hooks';

export const OptionsSearch = ({ options, placeholder, onChange, resetKey }) => {
  const optionSet = new Set(options);
  const listId = useId();

  return (
    <>
      {/* Only applies once the typed value is empty or matches a known option — avoids a
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
};
