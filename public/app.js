// Bootstrap. Must load last among rangeSlider.js/filters.js/songTable.js/
// tabs.js — loadFilters() and loadPage() are real top-level calls (not
// deferred to an event handler), so they need those files' functions to
// already be defined.
loadFilters();
loadPage();
