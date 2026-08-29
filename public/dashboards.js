const DASHBOARD_COLORS = {
  bg: '#121212',
  bgElevated: '#1a1a1a',
  text: '#ffffff',
  textMuted: '#b3b3b3',
  accent: '#1db954',
  border: '#282828',
};

let dashboardsLoaded = false;
let worldMapRegistered = false;

async function loadDashboards() {
  if (dashboardsLoaded) return;
  dashboardsLoaded = true;

  const res = await fetch('/api/stats');
  if (!res.ok) return;
  const { yearCounts, decadeCounts, popularityCounts, countryCounts, likedCounts } = await res.json();

  renderBarChart('year-chart', yearCounts.map((d) => d.year), yearCounts.map((d) => d.count), true, (year) =>
    window.applyDashboardFilter({ year })
  );
  renderBarChart(
    'decade-chart',
    decadeCounts.map((d) => d.decade),
    decadeCounts.map((d) => d.count),
    false,
    (decade) => window.applyDashboardFilter({ decade })
  );
  renderBarChart('liked-chart', likedCounts.map((d) => d.month), likedCounts.map((d) => d.count), true, (month) => {
    const { from, to } = monthRange(month);
    window.applyDashboardFilter({ addedFrom: from, addedTo: to });
  });
  renderBarChart(
    'popularity-chart',
    popularityCounts.map((d) => d.bucket),
    popularityCounts.map((d) => d.count),
    false,
    (bucket) => {
      const [popularityMin, popularityMax] = bucket.split('-').map(Number);
      window.applyDashboardFilter({ popularityMin, popularityMax });
    }
  );
  renderWorldMap(countryCounts);
}

function monthRange(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { from: from.toISOString(), to: to.toISOString() };
}

function baseChartOption() {
  return {
    backgroundColor: 'transparent',
    textStyle: { color: DASHBOARD_COLORS.text, fontFamily: 'Inter, sans-serif' },
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: DASHBOARD_COLORS.bgElevated,
      borderColor: DASHBOARD_COLORS.border,
      textStyle: { color: DASHBOARD_COLORS.text },
    },
  };
}

function renderBarChart(elementId, categories, values, rotateLabels, onClickCategory) {
  const chart = echarts.init(document.getElementById(elementId));
  chart.setOption({
    ...baseChartOption(),
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { rotate: rotateLabels ? 60 : 0, color: DASHBOARD_COLORS.textMuted, fontSize: 10 },
      axisLine: { lineStyle: { color: DASHBOARD_COLORS.border } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: DASHBOARD_COLORS.textMuted },
      splitLine: { lineStyle: { color: DASHBOARD_COLORS.border } },
    },
    series: [
      {
        type: 'bar',
        data: values,
        itemStyle: { color: DASHBOARD_COLORS.accent },
        emphasis: { itemStyle: { color: '#f5a623' } },
        cursor: onClickCategory ? 'pointer' : 'default',
      },
    ],
  });
  if (onClickCategory) {
    chart.on('click', (params) => onClickCategory(params.name));
  }
  window.addEventListener('resize', () => chart.resize());
}

async function renderWorldMap(data) {
  if (!worldMapRegistered) {
    const res = await fetch('/world.geo.json');
    const geoJson = await res.json();
    echarts.registerMap('world', geoJson);
    worldMapRegistered = true;
  }

  const points = data
    .filter((d) => COUNTRY_COORDS[d.code])
    .map((d) => ({
      name: countryLabel(d.code),
      value: [...COUNTRY_COORDS[d.code], d.count],
      code: d.code,
    }));

  const chart = echarts.init(document.getElementById('world-map-chart'));
  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: DASHBOARD_COLORS.bgElevated,
      borderColor: DASHBOARD_COLORS.border,
      textStyle: { color: DASHBOARD_COLORS.text },
      formatter: (p) => `${p.name}: ${p.value[2]} song${p.value[2] === 1 ? '' : 's'}`,
    },
    geo: {
      map: 'world',
      roam: true,
      itemStyle: {
        areaColor: DASHBOARD_COLORS.bgElevated,
        borderColor: DASHBOARD_COLORS.textMuted,
        borderWidth: 1,
      },
      emphasis: { itemStyle: { areaColor: DASHBOARD_COLORS.border } },
    },
    series: [
      {
        type: 'scatter',
        coordinateSystem: 'geo',
        data: points,
        // sqrt scaling keeps bubble *area* (not radius) proportional to count,
        // which is what the eye actually perceives correctly.
        symbolSize: (val) => Math.sqrt(val[2]) * 3 + 4,
        itemStyle: { color: DASHBOARD_COLORS.accent, opacity: 0.7 },
        cursor: 'pointer',
        emphasis: {
          itemStyle: { color: '#f5a623', opacity: 1 },
          label: { show: true, formatter: (p) => p.name, color: DASHBOARD_COLORS.text },
        },
      },
    ],
  });
  chart.on('click', (params) => {
    if (params.data?.code) window.applyDashboardFilter({ country: params.data.code });
  });
  window.addEventListener('resize', () => chart.resize());
}

window.loadDashboards = loadDashboards;
