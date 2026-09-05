import { useEffect, useState } from 'preact/hooks';

// Fixed-width window of page numbers that slides toward whichever edge it's near, plus
// first/last page with "…" bridging any gap.
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

// Targets 80% of content width, capped at #app's 1400px max (not the raw viewport) so this
// never ends up wider than the table above it. Button width is an estimate, not measured.
const APPROX_BUTTON_WIDTH_PX = 56;
const CONTENT_MAX_WIDTH_PX = 1400;
const TARGET_WIDTH_FRACTION = 0.8;
// Reserves slots for first page, last page, and up to two ellipses.
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

export const Pagination = ({ offset, limit, total, onOffsetChange }) => {
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
};
