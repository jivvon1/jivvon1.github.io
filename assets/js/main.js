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

// Keep --nav-h in sync with the fixed header's real height (it changes with
// the viewport width), and on the home page fold the brand row away once the
// page is scrolled. --nav-h keeps the unfolded height there, so the content
// doesn't jump when the header shrinks.
(function () {
  var nav = document.querySelector('.topnav-v2');
  if (!nav) return;
  var fixedCompact = nav.classList.contains('is-fixed-compact');
  function sync() {
    if (!fixedCompact && nav.classList.contains('is-compact')) return;
    document.documentElement.style.setProperty(
      '--nav-h', Math.round(nav.getBoundingClientRect().height) + 'px');
  }
  sync();
  if (window.ResizeObserver) new ResizeObserver(sync).observe(nav);
  else window.addEventListener('resize', sync);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync);

  if (fixedCompact) return;
  var ticking = false;
  function onScroll() {
    ticking = false;
    var y = window.scrollY;
    // hysteresis so the header doesn't flicker around the threshold
    if (y > 80) nav.classList.add('is-compact');
    else if (y < 20) nav.classList.remove('is-compact');
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();
})();
