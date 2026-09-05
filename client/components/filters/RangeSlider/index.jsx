// Two overlaid native range inputs sharing a track — the standard no-library dual-handle
// technique. Uncontrolled (refs); only calls back once the user releases.
import { useRef } from 'preact/hooks';

export const RangeSlider = ({ title, min, max, step, formatValue, onCommit }) => {
  const lowRef = useRef(null);
  const highRef = useRef(null);
  const labelRef = useRef(null);

  const updateLabel = () => {
    labelRef.current.textContent = `${formatValue(Number(lowRef.current.value))} – ${formatValue(
      Number(highRef.current.value)
    )}`;
  };

  const handleInput = (e) => {
    if (Number(lowRef.current.value) > Number(highRef.current.value)) {
      if (e.target === lowRef.current) lowRef.current.value = highRef.current.value;
      else highRef.current.value = lowRef.current.value;
    }
    updateLabel();
  };

  const handleCommit = () => {
    const lo = Number(lowRef.current.value);
    const hi = Number(highRef.current.value);
    // Full natural range means "not filtering" — some fields (e.g. popularity) are null for
    // songs with no value, and an active filter must exclude those.
    onCommit(lo === min && hi === max ? null : lo, lo === min && hi === max ? null : hi);
  };

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
};
