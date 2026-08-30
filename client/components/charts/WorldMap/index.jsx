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
  color = chartTheme.accent,
  emphasisColor = chartTheme.emphasis,
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
          itemStyle: {
            areaColor: chartTheme.bgElevated,
            borderColor: chartTheme.textMuted,
            borderWidth: 1,
          },
          emphasis: { itemStyle: { areaColor: chartTheme.border } },
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
            emphasis: {
              itemStyle: { color: emphasisColor, opacity: 1 },
              label: { show: true, formatter: (p) => p.name, color: chartTheme.text },
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
