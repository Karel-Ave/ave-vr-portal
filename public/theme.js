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
        // Notify iframes (storage event unreliable in iOS Safari iframes)
        document.querySelectorAll('iframe').forEach(function(f) {
          try { f.contentWindow.postMessage({ type: 'ave-theme', dark: newDark }, '*'); } catch(e) {}
        });
      });
    }

    // Sync with server preference.
    // Rule: if localStorage already has a value (user has chosen before on
    // this browser), that value wins and is pushed to the server.
    // Only when localStorage has never been set (truly new device/browser)
    // do we pull the server preference — this gives cross-device sync on
    // first login while respecting any explicit local choice (e.g. toggling
    // on the login page before signing in).
    fetch('/api/me').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (user) {
      if (!user || !user.theme) return;
      var serverDark = user.theme === 'dark';
      var localRaw   = localStorage.getItem(KEY); // null = never set on this browser

      if (localRaw === null) {
        // New browser / cleared storage → adopt server preference
        localStorage.setItem(KEY, serverDark ? 'dark' : 'light');
        applyTheme(serverDark);
      } else {
        // Local preference exists → push it to server to keep in sync
        var localDark = localRaw === 'dark';
        if (serverDark !== localDark) saveToServer(localDark);
      }
    }).catch(function () {});
  }

  // React to theme changes made in other windows/frames (e.g. portal topbar
  // toggling while blacklist is open in the iframe)
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) applyTheme(e.newValue === 'dark');
  });

  // postMessage fallback for iOS Safari where storage events don't fire in iframes
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ave-theme') {
      applyTheme(e.data.dark);
      // Propagate further into nested iframes
      document.querySelectorAll('iframe').forEach(function(f) {
        try { f.contentWindow.postMessage(e.data, '*'); } catch(err) {}
      });
    }
  });

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
