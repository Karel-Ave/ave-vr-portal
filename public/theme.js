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

  // Apply immediately from localStorage to prevent FOUC
  applyTheme(localStorage.getItem(KEY) === 'dark');

  function saveToServer(dark) {
    try {
      fetch('/api/me/theme', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: dark ? 'dark' : 'light' })
      }).catch(function () {});
    } catch (e) {}
  }

  function setup() {
    var btn = document.getElementById('btn-theme');
    if (btn) {
      btn.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
      btn.addEventListener('click', function () {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var newDark = !isDark;
        localStorage.setItem(KEY, newDark ? 'dark' : 'light');
        applyTheme(newDark);
        saveToServer(newDark);
      });
    }

    // Sync with server preference (overrides localStorage if different)
    fetch('/api/me').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (user) {
      if (!user || !user.theme) return;
      var serverDark = user.theme === 'dark';
      var localDark  = localStorage.getItem(KEY) === 'dark';
      if (serverDark !== localDark) {
        localStorage.setItem(KEY, serverDark ? 'dark' : 'light');
        applyTheme(serverDark);
      }
    }).catch(function () {});
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
