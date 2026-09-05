// Controlled, since filter values can be set externally (a dashboard chart click).
//
// Named `keyOf`, not `valueOf` — every object inherits `valueOf` from Object.prototype,
// so a destructured `valueOf = (o) => o` default never applies, and calling the inherited
// native method as a bare function throws. Learned this the hard way — avoid any
// Object.prototype member name here (valueOf, toString, constructor, etc.).
export const OptionsSelect = ({ value, onChange, allLabel, options, keyOf = (o) => o, labelOf = (o) => o }) => <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={keyOf(option)} value={keyOf(option)}>
          {labelOf(option)}
        </option>
      ))}
    </select>;
