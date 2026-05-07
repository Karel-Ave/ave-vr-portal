(function () {
  var KEY = 'ave-portal-theme';

  function applyTheme(dark) {
    if (dark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    var btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = dark ? '☀️' : '🌙';
  }

  // Apply immediately (before DOM ready) to prevent FOUC
  applyTheme(localStorage.getItem(KEY) === 'dark');

  function setup() {
    var btn = document.getElementById('btn-theme');
    if (!btn) return;
    btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
    btn.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      localStorage.setItem(KEY, isDark ? 'light' : 'dark');
      applyTheme(!isDark);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
