// Tab switching (List <-> Dashboards) and the bridge that lets a dashboard
// chart click (dashboards.js) jump to the List tab pre-filtered.

function switchTab(tab) {
  for (const b of document.querySelectorAll('.tab-button')) {
    b.classList.toggle('active', b.dataset.tab === tab);
  }
  document.getElementById('list-tab').style.display = tab === 'list' ? '' : 'none';
  document.getElementById('dashboards-tab').style.display = tab === 'dashboards' ? '' : 'none';

  if (tab === 'dashboards' && window.loadDashboards) {
    window.loadDashboards();
  }
}

// Called from a dashboard chart click (year bar, decade bar, popularity
// bucket, liked-date bar, country bubble). Clears every other filter first
// — clicking a chart element means "show me exactly this," not "also
// narrow whatever was already filtered" — applies the one update, syncs
// the matching dropdown if there is one, and jumps to the List tab.
function applyDashboardFilter(updates) {
  resetFilterState();
  if (updates.year !== undefined) {
    yearFilter = updates.year;
    if (filterControls.yearSelect) filterControls.yearSelect.value = updates.year;
  }
  if (updates.decade !== undefined) {
    decadeFilter = updates.decade;
    if (filterControls.decadeSelect) filterControls.decadeSelect.value = updates.decade;
  }
  if (updates.country !== undefined) {
    countryFilter = updates.country;
    if (filterControls.countrySelect) filterControls.countrySelect.value = updates.country;
  }
  if (updates.playlist !== undefined) {
    playlistFilter = updates.playlist;
    if (filterControls.playlistSelect) filterControls.playlistSelect.value = updates.playlist;
  }
  if (updates.popularityMin !== undefined) popularityMin = updates.popularityMin;
  if (updates.popularityMax !== undefined) popularityMax = updates.popularityMax;
  if (updates.addedFrom !== undefined) addedFrom = updates.addedFrom;
  if (updates.addedTo !== undefined) addedTo = updates.addedTo;

  offset = 0;
  switchTab('list');
  loadPage();
}
window.applyDashboardFilter = applyDashboardFilter;

for (const button of document.querySelectorAll('.tab-button')) {
  button.onclick = () => switchTab(button.dataset.tab);
}
