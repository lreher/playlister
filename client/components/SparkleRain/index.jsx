import { useEffect, useMemo, useState } from 'preact/hooks';
import './style.css';

// Same clashing-neon-plus-white palette as the rest of the Nicolas theme
// (index.css's --grad-*/--accent tokens) — not read from CSS vars since
// each sparkle needs its own independently-random pick, not the theme's
// single accent.
const SPARKLE_COLORS = ['#ffffff', '#ff1493', '#7cff00', '#ffd000', '#17c3b2', '#9b3fe0'];
const SPARKLE_COUNT = 40;

const randomBetween = (min, max) => min + Math.random() * (max - min);

function makeSparkles() {
  return Array.from({ length: SPARKLE_COUNT }, (_, i) => ({
    id: i,
    left: `${randomBetween(0, 100)}%`,
    size: `${randomBetween(8, 22)}px`,
    color: SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)],
    duration: `${randomBetween(7, 16)}s`,
    // Negative delay starts each sparkle mid-fall instead of every one
    // dropping from the top together on first paint.
    delay: `-${randomBetween(0, 16)}s`,
  }));
}

// Watches <html data-theme> directly rather than taking a theme prop, so
// this renders correctly on every screen App.jsx shows — including the
// pre-login/loading states that exist before App's own theme state does.
// 'studio' is the bare :root (see client/theme.js), so absence of the
// attribute correctly means "not nicolas" here too.
function useIsNicolas() {
  const [isNicolas, setIsNicolas] = useState(() => document.documentElement.dataset.theme === 'nicolas');

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsNicolas(document.documentElement.dataset.theme === 'nicolas');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return isNicolas;
}

export function SparkleRain() {
  const isNicolas = useIsNicolas();
  const sparkles = useMemo(makeSparkles, []);

  if (!isNicolas) return null;

  return (
    <div className="sparkle-rain" aria-hidden="true">
      {sparkles.map((s) => (
        <span
          key={s.id}
          className="sparkle"
          style={{
            left: s.left,
            width: s.size,
            height: s.size,
            color: s.color,
            animationDuration: s.duration,
            animationDelay: s.delay,
          }}
        />
      ))}
    </div>
  );
}
