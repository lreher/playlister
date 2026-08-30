// Two overlaid native range inputs sharing a track — the standard
// no-library technique for a dual-handle slider. Uncontrolled on purpose:
// the two <input>s own their own live drag value (via refs), and only call
// back up (onCommit) once the user releases — re-rendering from props on
// every drag tick would fight the native input's own value.
import { useRef } from 'preact/hooks';

export function RangeSlider({ title, min, max, step, formatValue, onCommit }) {
  const lowRef = useRef(null);
  const highRef = useRef(null);
  const labelRef = useRef(null);

  function updateLabel() {
    labelRef.current.textContent = `${formatValue(Number(lowRef.current.value))} – ${formatValue(
      Number(highRef.current.value)
    )}`;
  }

  function handleInput(e) {
    if (Number(lowRef.current.value) > Number(highRef.current.value)) {
      if (e.target === lowRef.current) lowRef.current.value = highRef.current.value;
      else highRef.current.value = lowRef.current.value;
    }
    updateLabel();
  }

  function handleCommit() {
    const lo = Number(lowRef.current.value);
    const hi = Number(highRef.current.value);
    // Dragged back out to the full natural range means "not filtering" —
    // distinct from actually filtering down to that same numeric span,
    // since some fields (e.g. artist popularity) are null for songs with no
    // known value, and an active min/max filter must exclude those.
    onCommit(lo === min && hi === max ? null : lo, lo === min && hi === max ? null : hi);
  }

  return (
    <div className="range-slider">
      <div className="range-slider-title">{title}</div>
      <div className="range-slider-label" ref={labelRef}>
        {formatValue(min)} – {formatValue(max)}
      </div>
      <div className="range-slider-track">
        <input
          ref={lowRef}
          type="range"
          className="range-slider-input"
          min={min}
          max={max}
          step={step}
          defaultValue={min}
          onInput={handleInput}
          onChange={handleCommit}
        />
        <input
          ref={highRef}
          type="range"
          className="range-slider-input"
          min={min}
          max={max}
          step={step}
          defaultValue={max}
          onInput={handleInput}
          onChange={handleCommit}
        />
      </div>
    </div>
  );
}
