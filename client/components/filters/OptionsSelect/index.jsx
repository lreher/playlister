// Generic <select> with a leading "All ___" option, built from a list of
// either plain values or objects (via valueOf/labelOf). Controlled —
// filter values can be set from outside (a dashboard chart click), so the
// dropdown has to follow filter state, not just push to it.
export function OptionsSelect({ value, onChange, allLabel, options, valueOf = (o) => o, labelOf = (o) => o }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={valueOf(option)} value={valueOf(option)}>
          {labelOf(option)}
        </option>
      ))}
    </select>
  );
}
