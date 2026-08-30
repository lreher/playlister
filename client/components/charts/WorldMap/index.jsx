// Generic echarts bubble-map primitive: draws point data (already shaped
// as [{name, value: [lon, lat, magnitude], ...}]) on top of a world map.
// Registers the base map once — echarts.registerMap() is global to the
// library itself, not per-instance, so that flag is module-level, not
// component state. What each point *means* (country lookup, tooltip
// wording, click behavior) is the caller's job, not this primitive's.
import { useEffect, useRef } from 'preact/hooks';
import { chartTheme } from '../../../themes/chartTheme';
import { getWorldGeoJson } from '../../../api';

let worldMapRegistered = false;

export function WorldMap({
  points,
  // Default: the shared theme colors — omit any of these to revert just
  // that one to the theme. `color`/`emphasisColor` can also be an
  // echarts-style callback `(params) => color` (params.value,
  // params.dataIndex, ...) instead of a flat string, for a color that
  // depends on each point's own data.
  color = chartTheme.accent, // the bubble itself
  emphasisColor = chartTheme.emphasis, // the bubble on hover
  formatTooltip = (p) => `${p.name}: ${p.value[2]}`,
  onPointClick,
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let chart;

    async function draw() {
      if (!worldMapRegistered) {
        const geoJson = await getWorldGeoJson();
        if (cancelled) return;
        echarts.registerMap('world', geoJson);
        worldMapRegistered = true;
      }

      chart = echarts.init(containerRef.current);
      chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'item',
          backgroundColor: chartTheme.bgElevated,
          borderColor: chartTheme.border,
          textStyle: { color: chartTheme.text },
          formatter: formatTooltip,
        },
        geo: {
          map: 'world',
          roam: true,
          // Fully non-interactive on purpose — no hover highlight, label, or
          // tooltip for bare landmass. The bubbles (series below) are a
          // separate layer drawn on top and keep their own hover behavior
          // untouched; this only silences the base map shapes themselves.
          // (Matching regions by name to re-enable hover just for countries
          // with data was considered and rejected — this map's own region
          // names don't reliably match countryLabel()'s output, e.g. South
          // Korea is just "Korea" here, so name-matching would silently
          // miss real countries.)
          silent: true,
          itemStyle: {
            areaColor: chartTheme.bgElevated,
            borderColor: chartTheme.textMuted,
            borderWidth: 1,
          },
        },
        series: [
          {
            type: 'scatter',
            coordinateSystem: 'geo',
            data: points,
            // sqrt scaling keeps bubble *area* (not radius) proportional to
            // magnitude, which is what the eye actually perceives correctly.
            symbolSize: (val) => Math.sqrt(val[2]) * 3 + 4,
            itemStyle: { color, opacity: 0.7 },
            cursor: onPointClick ? 'pointer' : 'default',
            // scale: false — the tooltip already names the country on
            // hover, so no on-map label either; and no size-grow on top of
            // our own already-large sqrt-scaled sizing.
            emphasis: {
              scale: false,
              itemStyle: { color: emphasisColor, opacity: 1 },
            },
          },
        ],
      });
      if (onPointClick) {
        chart.on('click', (params) => {
          if (params.data) onPointClick(params.data);
        });
      }
    }

    draw();
    const handleResize = () => chart?.resize();
    window.addEventListener('resize', handleResize);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
      chart?.dispose();
    };
  }, []);

  return <div className="chart-container chart-container-map" ref={containerRef} />;
}
