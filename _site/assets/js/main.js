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

// Keep --nav-h in sync with the fixed top bar's real height.
// It is not constant: the brand subtitle wraps to two lines on narrow screens,
// and everything anchored below the bar (sticky tab strip, sticky profile rail,
// page top padding, scroll-padding) is positioned from this value.
(function () {
  var nav = document.querySelector('.topnav-v2');
  if (!nav) return;
  function sync() {
    document.documentElement.style.setProperty(
      '--nav-h', Math.round(nav.getBoundingClientRect().height) + 'px');
  }
  sync();
  if (window.ResizeObserver) new ResizeObserver(sync).observe(nav);
  else window.addEventListener('resize', sync);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync);
})();
