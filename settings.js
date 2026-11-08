// Power-user settings, kept in this browser's localStorage and shared by the
// upload page and /settings. Everything read back is re-validated, so a hand
// edited or corrupt value can never put the page into a broken state.
(function (global) {
  var KEY = 'th_settings';
  var SHORTENERS = ['auto', 'dagd', 'tinyurl', 'none', 'custom'];
  var AUTO_DOWNLOADS = ['smart', 'always', 'never'];
  var DEFAULTS = { historyMax: 100, shortener: 'auto', customShortener: '', concurrency: 2, autoDownload: 'smart' };

  function clamp(value, min, max, fallback) {
    var n = Math.round(Number(value));
    return isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  // https only, and it must say where the link goes: https://example.com/s?u={url}
  function validTemplate(template) {
    template = String(template || '');
    if (template.indexOf('{url}') === -1) return false;
    try {
      return new URL(template.split('{url}').join('x')).protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var out = {
      historyMax: clamp(raw.historyMax, 0, 500, DEFAULTS.historyMax),
      shortener: SHORTENERS.indexOf(raw.shortener) >= 0 ? raw.shortener : DEFAULTS.shortener,
      customShortener: typeof raw.customShortener === 'string' ? raw.customShortener.slice(0, 300) : '',
      concurrency: clamp(raw.concurrency, 1, 3, DEFAULTS.concurrency),
      autoDownload: AUTO_DOWNLOADS.indexOf(raw.autoDownload) >= 0 ? raw.autoDownload : DEFAULTS.autoDownload,
    };
    if (out.shortener === 'custom' && !validTemplate(out.customShortener)) out.shortener = DEFAULTS.shortener;
    return out;
  }

  function load() {
    try {
      return normalize(JSON.parse(localStorage.getItem(KEY)));
    } catch (_) {
      return normalize(null);
    }
  }

  function save(settings) {
    var clean = normalize(settings);
    try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch (_) { /* storage unavailable */ }
    return clean;
  }

  global.THSettings = { load: load, save: save, normalize: normalize, validTemplate: validTemplate, DEFAULTS: DEFAULTS };
})(window);
