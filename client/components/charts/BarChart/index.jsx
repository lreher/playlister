// Generic echarts bar chart primitive. categories/values are whole-library
// stats fetched once by Dashboards.jsx — stable for this component's
// lifetime, so the chart is built once (empty deps) and just resized on
// window resize.
import { useEffect, useRef } from 'preact/hooks';
import { chartTheme, baseChartOption, barGradient } from '../../../themes/chartTheme';

export function BarChart({
  categories,
  values,
  rotateLabels,
  // Default: the shared purple->magenta gradient (chartTheme.barGradient),
  // orange on hover — omit these two props entirely to revert a chart to
  // it. Either can also be an echarts-style callback `(params) => color`
  // (params.value, params.dataIndex, ...) instead of a flat string/gradient,
  // for a color that depends on each bar's own data — e.g. a chart that
  // gets redder the higher its value.
  color = barGradient,
  emphasisColor = chartTheme.emphasis,
  onClickCategory,
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    const chart = echarts.init(containerRef.current);
    chart.setOption({
      ...baseChartOption(),
      xAxis: {
        type: 'category',
        data: categories,
        axisLabel: { rotate: rotateLabels ? 60 : 0, color: chartTheme.textMuted, fontSize: 10 },
        axisLine: { lineStyle: { color: chartTheme.border } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: chartTheme.textMuted },
        splitLine: { lineStyle: { color: chartTheme.border } },
      },
      series: [
        {
          type: 'bar',
          data: values,
          itemStyle: { color },
          emphasis: { itemStyle: { color: emphasisColor } },
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
