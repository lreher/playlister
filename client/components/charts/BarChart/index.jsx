// Generic echarts bar chart primitive. categories/values are whole-library
// stats fetched once by Dashboards.jsx — stable for this component's
// lifetime, so the chart is built once (empty deps) and just resized on
// window resize. Theme is read fresh at build time (getChartTheme), so a
// theme switch recolors it on the next Dashboards remount.
import { useEffect, useRef } from 'preact/hooks';
import { getChartTheme, baseChartOption, barGradient } from '../../../themes/chartTheme';

export function BarChart({
  categories,
  values,
  rotateLabels,
  // Omit both to get the shared theme look: a purple->magenta gradient
  // fill (flat green in the classic theme), orange on hover. Either can
  // also be an echarts-style callback `(params) => color` (params.value,
  // params.dataIndex, ...) for a color that depends on each bar's own data.
  color,
  emphasisColor,
  onClickCategory,
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    const theme = getChartTheme();
    const fill = color ?? barGradient(theme);
    const emphasisFill = emphasisColor ?? theme.emphasis;

    const chart = echarts.init(containerRef.current);
    chart.setOption({
      ...baseChartOption(theme),
      xAxis: {
        type: 'category',
        data: categories,
        axisLabel: { rotate: rotateLabels ? 60 : 0, color: theme.textMuted, fontSize: 10 },
        axisLine: { lineStyle: { color: theme.border } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: theme.textMuted },
        splitLine: { lineStyle: { color: theme.border } },
      },
      series: [
        {
          type: 'bar',
          data: values,
          itemStyle: { color: fill },
          emphasis: { itemStyle: { color: emphasisFill } },
          cursor: onClickCategory ? 'pointer' : 'default',
        },
      ],
    });
    if (onClickCategory) chart.on('click', (params) => onClickCategory(params.name));

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      chart.dispose();
    };
  }, []);

  return <div className="chart-container" ref={containerRef} />;
}
