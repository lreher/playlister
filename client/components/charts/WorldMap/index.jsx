// echarts.registerMap() is global to the library, not per-instance, hence the module-level flag.
import { useEffect, useRef } from 'preact/hooks';
import { getChartTheme } from '../../../themes/chartTheme';
import { getWorldGeoJson } from '../../../api';

let worldMapRegistered = false;

export const WorldMap = ({
  points,
  // Omit to fall back to the theme accent/emphasis; either can be an echarts-style (params) => color callback.
  color, // the bubble itself
  emphasisColor, // the bubble on hover
  formatTooltip = (p) => `${p.name}: ${p.value[2]}`,
  onPointClick,
}) => {
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let chart;

    const draw = async () => {
      if (!worldMapRegistered) {
        const geoJson = await getWorldGeoJson();
        if (cancelled) return;
        echarts.registerMap('world', geoJson);
        worldMapRegistered = true;
      }

      const chartTheme = getChartTheme();
      const bubbleColor = color ?? chartTheme.accent;
      const bubbleEmphasis = emphasisColor ?? chartTheme.emphasis;
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
          // No hover/label on bare landmass — only the bubble layer above responds. Matching
          // bubbles to map regions by name was tried and dropped: this map's region names
          // don't reliably match countryLabel() (e.g. "Korea" vs South Korea).
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
            // sqrt scaling keeps bubble area (not radius) proportional to magnitude.
            symbolSize: (val) => Math.sqrt(val[2]) * 3 + 4,
            itemStyle: { color: bubbleColor, opacity: 0.7 },
            cursor: onPointClick ? 'pointer' : 'default',
            // No scale-grow on hover — bubbles are already sqrt-sized, and the tooltip names the country.
            emphasis: {
              scale: false,
              itemStyle: { color: bubbleEmphasis, opacity: 1 },
            },
          },
        ],
      });
      if (onPointClick) {
        chart.on('click', (params) => {
          if (params.data) onPointClick(params.data);
        });
      }
    };

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
};
