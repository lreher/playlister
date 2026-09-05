// Built once (empty deps) since categories/values are stable for this component's lifetime;
// theme is read fresh, so a remount recolors it after a theme switch.
import { useEffect, useRef } from 'preact/hooks';
import { getChartTheme, baseChartOption, barGradient } from '../../../themes/chartTheme';

export const BarChart = ({
  categories,
  values,
  rotateLabels,
  // Omit both for the shared gradient look; either can be an echarts-style (params) => color callback.
  color,
  emphasisColor,
  onClickCategory,
}) => {
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
};
