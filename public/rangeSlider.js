// Two overlaid native range inputs sharing a track — the standard
// no-library technique for a dual-handle slider. No dependencies on the
// rest of the app; used by filters.js.
function createDualSlider({ title, min, max, step, formatValue, onCommit }) {
  const container = document.createElement('div');
  container.className = 'range-slider';

  const titleEl = document.createElement('div');
  titleEl.className = 'range-slider-title';
  titleEl.textContent = title;

  const label = document.createElement('div');
  label.className = 'range-slider-label';

  const track = document.createElement('div');
  track.className = 'range-slider-track';

  const lowInput = document.createElement('input');
  lowInput.type = 'range';
  lowInput.min = min;
  lowInput.max = max;
  lowInput.step = step;
  lowInput.value = min;
  lowInput.className = 'range-slider-input';

  const highInput = document.createElement('input');
  highInput.type = 'range';
  highInput.min = min;
  highInput.max = max;
  highInput.step = step;
  highInput.value = max;
  highInput.className = 'range-slider-input';

  function updateLabel() {
    label.textContent = `${formatValue(Number(lowInput.value))} – ${formatValue(Number(highInput.value))}`;
  }

  function handleInput(e) {
    if (Number(lowInput.value) > Number(highInput.value)) {
      if (e.target === lowInput) lowInput.value = highInput.value;
      else highInput.value = lowInput.value;
    }
    updateLabel();
  }

  function handleCommit() {
    const lo = Number(lowInput.value);
    const hi = Number(highInput.value);
    // Dragged back out to the full natural range means "not filtering" —
    // distinct from actually filtering down to that same numeric span,
    // since some fields (e.g. artist popularity) are null for songs with no
    // known value, and an active min/max filter must exclude those.
    onCommit(lo === min && hi === max ? null : lo, lo === min && hi === max ? null : hi);
  }

  function reset() {
    lowInput.value = min;
    highInput.value = max;
    updateLabel();
  }

  lowInput.addEventListener('input', handleInput);
  highInput.addEventListener('input', handleInput);
  lowInput.addEventListener('change', handleCommit);
  highInput.addEventListener('change', handleCommit);

  updateLabel();
  track.appendChild(lowInput);
  track.appendChild(highInput);
  container.appendChild(titleEl);
  container.appendChild(label);
  container.appendChild(track);
  container.reset = reset;
  return container;
}
