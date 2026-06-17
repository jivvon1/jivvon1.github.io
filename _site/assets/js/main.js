// Theme toggle (light/dark)
(function () {
  function init() {
    var root = document.documentElement;
    var stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') {
      root.setAttribute('data-theme', stored);
    }
    var btn = document.getElementById('themeToggle');
    console.log('[theme] init', { btn: !!btn, stored: stored, current: root.getAttribute('data-theme') });
    if (!btn) return;
    btn.addEventListener('click', function () {
      var cur = root.getAttribute('data-theme')
        || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      var next = cur === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      console.log('[theme] toggle', cur, '->', next);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
