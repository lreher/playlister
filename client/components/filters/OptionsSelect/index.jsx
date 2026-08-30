// Generic <select> with a leading "All ___" option, built from a list of
// either plain values or objects (via keyOf/labelOf). Controlled —
// filter values can be set from outside (a dashboard chart click), so the
// dropdown has to follow filter state, not just push to it.
//
// Named `keyOf`, not `valueOf` — that name is a real trap here. Every plain
// object inherits `valueOf` from Object.prototype, so a destructured
// `valueOf = (o) => o` default *never* applies (`props.valueOf` is never
// undefined, it resolves to the inherited native method), and calling that
// bare as a function throws "Cannot convert undefined or null to object".
// Learned this the hard way — keep the name away from any Object.prototype
// member (valueOf, toString, constructor, etc.).
export function OptionsSelect({ value, onChange, allLabel, options, keyOf = (o) => o, labelOf = (o) => o }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={keyOf(option)} value={keyOf(option)}>
          {labelOf(option)}
        </option>
      ))}
    </select>
  );
}
