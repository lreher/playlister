import { useEffect, useState } from 'preact/hooks';

// Truncated page-number pagination — a fixed-width window of page numbers
// around the current page, always the same size regardless of where
// current sits (slides toward whichever edge it's near instead of just
// clamping and shrinking), plus the first/last page with "…" bridging any
// gap. Works directly off offset/limit/total, the same shape the caller
// already tracks — no separate page-number concept to convert to/from.
const buildPageList = (current, pageCount, siblingCount) => {
  let start = current - siblingCount;
  let end = current + siblingCount;

  if (start < 1) {
    end = Math.min(pageCount, end + (1 - start));
    start = 1;
  }
  if (end > pageCount) {
    start = Math.max(1, start - (end - pageCount));
    end = pageCount;
  }

  const pages = [];
  if (start > 1) {
    pages.push(1);
    if (start > 2) pages.push('left-ellipsis');
  }
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < pageCount) {
    if (end < pageCount - 1) pages.push('right-ellipsis');
    pages.push(pageCount);
  }

  return pages;
};

// The page-number bar targets 80% of the available content width (capped
// at #app's own 1400px max-width, not the raw viewport — otherwise on a
// wide monitor this bar could end up visibly wider than the table sitting
// right above it). Approximate px-per-button (width + gap); a toy app
// doesn't need pixel-perfect DOM measurement here — being off by one
// button just means slightly more/less padding, not a real bug.
const APPROX_BUTTON_WIDTH_PX = 56;
const CONTENT_MAX_WIDTH_PX = 1400;
const TARGET_WIDTH_FRACTION = 0.8;
// Reserve slots for the first page, last page, and up to two ellipses —
// whatever's left over is split evenly between both sides of current.
const RESERVED_SLOTS = 4;

const computeSiblingCount = () => {
  const availableWidth = Math.min(window.innerWidth, CONTENT_MAX_WIDTH_PX) * TARGET_WIDTH_FRACTION;
  const maxButtons = Math.floor(availableWidth / APPROX_BUTTON_WIDTH_PX);
  const remaining = Math.max(0, maxButtons - RESERVED_SLOTS);
  return Math.max(1, Math.floor(remaining / 2));
};

const useAvailableSiblingCount = () => {
  const [siblingCount, setSiblingCount] = useState(computeSiblingCount);

  useEffect(() => {
    const handleResize = () => setSiblingCount(computeSiblingCount());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return siblingCount;
};

export function Pagination({ offset, limit, total, onOffsetChange }) {
  const siblingCount = useAvailableSiblingCount();
  const pageCount = Math.ceil(total / limit);
  if (pageCount <= 1) return null;

  const current = Math.floor(offset / limit) + 1;
  const pages = buildPageList(current, pageCount, siblingCount);

  return (
    <div className="pagination">
      {pages.map((p) =>
        typeof p === 'number' ? (
          <button
            key={p}
            className={`page-button pagination-page ${p === current ? 'active' : ''}`}
            disabled={p === current}
            onClick={() => onOffsetChange((p - 1) * limit)}
          >
            {p}
          </button>
        ) : (
          <span key={p} className="pagination-ellipsis">
            …
          </span>
        )
      )}
    </div>
  );
}
