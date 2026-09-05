import { useEffect, useMemo, useState } from 'preact/hooks';
import './style.css';

// Same palette as the rest of Nicolas theme, picked per-sparkle instead of read from CSS vars.
const SPARKLE_COLORS = ['#ffffff', '#ff1493', '#7cff00', '#ffd000', '#17c3b2', '#9b3fe0'];
const SPARKLE_COUNT = 40;

const randomBetween = (min, max) => min + Math.random() * (max - min);

const makeSparkles = () => Array.from({ length: SPARKLE_COUNT }, (_, i) => ({
    id: i,
    left: `${randomBetween(0, 100)}%`,
    size: `${randomBetween(8, 22)}px`,
    color: SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)],
    duration: `${randomBetween(7, 16)}s`,
    // Negative delay starts each sparkle mid-fall instead of all dropping from the top together.
    delay: `-${randomBetween(0, 16)}s`,
  }));

// Watches data-theme directly instead of taking a prop, so this works on pre-login screens
// too, before App's own theme state exists.
const useIsNicolas = () => {
  const [isNicolas, setIsNicolas] = useState(() => document.documentElement.dataset.theme === 'nicolas');

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsNicolas(document.documentElement.dataset.theme === 'nicolas');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return isNicolas;
};

export const SparkleRain = () => {
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
};
