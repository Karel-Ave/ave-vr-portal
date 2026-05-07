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

  // ── Inverted favicon so the logo is visible on light browser chrome ──
  function setInvertedFavicon() {
    var img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        var ctx = c.getContext('2d');
        ctx.filter = 'invert(1)';
        ctx.drawImage(img, 0, 0, 64, 64);
        var link = document.querySelector("link[rel='icon']");
        if (!link) {
          link = document.createElement('link');
          link.rel = 'icon';
          document.head.appendChild(link);
        }
        link.type = 'image/png';
        link.href = c.toDataURL('image/png');
      } catch (e) {}
    };
    img.src = '/static/logo.png';
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setInvertedFavicon);
  } else {
    setInvertedFavicon();
  }
})();
