(function () {
  var THEME_KEY = 'ave-portal-theme';
  var SKIN_KEY = 'ave-portal-skin';
  var USER_KEY = 'ave-portal-theme-user';
  var DEFAULT_SKIN = 'default';
  var SKINS = [
    { id: 'default', label: 'Výchozí' },
    { id: 'graphite', label: 'Grafit' },
    { id: 'slate', label: 'Slate' },
    { id: 'blue', label: 'Modrá' },
    { id: 'teal', label: 'Teal' },
    { id: 'green', label: 'Zelená' },
    { id: 'olive', label: 'Oliva' },
    { id: 'amber', label: 'Amber' },
    { id: 'rose', label: 'Rose' },
    { id: 'violet', label: 'Violet' },
    { id: 'indigo', label: 'Indigo' },
    { id: 'cyan', label: 'Cyan' },
    { id: 'mint', label: 'Mint' },
    { id: 'lime', label: 'Lime' },
    { id: 'yellow', label: 'Žlutá' },
    { id: 'orange', label: 'Oranžová' },
    { id: 'red', label: 'Červená' },
    { id: 'pink', label: 'Pink' },
    { id: 'plum', label: 'Plum' },
    { id: 'coffee', label: 'Coffee' },
    { id: 'navy', label: 'Navy' }
  ];
  var SKIN_IDS = SKINS.map(function (s) { return s.id; });
  var lastThemeToggle = 0;
  var lastLocalThemeChange = 0;

  function normalizeSkin(skin) {
    skin = String(skin || DEFAULT_SKIN).toLowerCase();
    return SKIN_IDS.indexOf(skin) >= 0 ? skin : DEFAULT_SKIN;
  }

  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function getSkin() {
    return normalizeSkin(document.documentElement.getAttribute('data-skin') || localStorage.getItem(SKIN_KEY));
  }

  function applyTheme(dark, skin) {
    skin = normalizeSkin(skin || localStorage.getItem(SKIN_KEY));
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    document.documentElement.setAttribute('data-skin', skin);
    var btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = dark ? '☀️' : '🌙';
  }

  function postThemeMessage(dark, skin) {
    document.querySelectorAll('iframe').forEach(function(f) {
      try { f.contentWindow.postMessage({ type: 'ave-theme', dark: dark, skin: skin }, '*'); } catch(e) {}
    });
  }

  function saveToServer(dark, skin) {
    try {
      fetch('/api/me/theme', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: dark ? 'dark' : 'light', skin: normalizeSkin(skin) })
      }).catch(function () {});
    } catch (e) {}
  }

  function setThemeMode(dark, persist) {
    var skin = getSkin();
    if (persist !== false) lastLocalThemeChange = Date.now();
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    applyTheme(dark, skin);
    postThemeMessage(dark, skin);
    if (persist !== false) saveToServer(dark, skin);
  }

  function setSkin(skin, persist) {
    skin = normalizeSkin(skin);
    var dark = isDark();
    if (persist !== false) lastLocalThemeChange = Date.now();
    localStorage.setItem(SKIN_KEY, skin);
    applyTheme(dark, skin);
    postThemeMessage(dark, skin);
    if (persist !== false) saveToServer(dark, skin);
  }

  function toggleThemeNow() {
    if (Date.now() - lastThemeToggle < 800) return false;
    lastThemeToggle = Date.now();
    setThemeMode(!isDark(), true);
    return false;
  }

  function toggleFromEvent(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    return toggleThemeNow();
  }

  applyTheme(localStorage.getItem(THEME_KEY) === 'dark', normalizeSkin(localStorage.getItem(SKIN_KEY)));

  window.AVE_THEME_SKINS = SKINS;
  window.AVE_THEME = {
    apply: applyTheme,
    isDark: isDark,
    getSkin: getSkin,
    setMode: setThemeMode,
    setSkin: setSkin,
    toggle: toggleThemeNow,
    skins: SKINS
  };

  function setup() {
    var btn = document.getElementById('btn-theme');
    if (btn) {
      btn.textContent = isDark() ? '☀️' : '🌙';
      btn.style.touchAction = 'manipulation';
      btn.style.webkitTapHighlightColor = 'transparent';
      function toggleThemeButton(e) {
        toggleFromEvent(e);
      }
      btn.addEventListener('touchstart', toggleThemeButton, { passive: false });
      btn.addEventListener('pointerdown', toggleThemeButton, { passive: false });
      btn.addEventListener('touchend', function(e) {
        toggleThemeButton(e);
      }, { passive: false });
      btn.addEventListener('pointerup', toggleThemeButton, { passive: false });
      btn.addEventListener('click', toggleThemeButton);
    }

    fetch('/api/me', { credentials: 'include' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (user) {
      if (!user) return;
      var serverDark = user.theme === 'dark';
      var serverSkin = normalizeSkin(user.theme_skin || DEFAULT_SKIN);
      var userKey = String(user.id || user.username || '');

      // Server preference belongs to the logged-in user. Local storage is only a
      // fast paint cache, so it must not leak the previous user's skin/mode.
      if (Date.now() - lastLocalThemeChange < 1500) return;
      localStorage.setItem(USER_KEY, userKey);
      localStorage.setItem(THEME_KEY, serverDark ? 'dark' : 'light');
      localStorage.setItem(SKIN_KEY, serverSkin);
      applyTheme(serverDark, serverSkin);
      postThemeMessage(serverDark, serverSkin);
    }).catch(function () {});
  }

  window.addEventListener('storage', function (e) {
    if (e.key === THEME_KEY || e.key === SKIN_KEY) {
      applyTheme(localStorage.getItem(THEME_KEY) === 'dark', normalizeSkin(localStorage.getItem(SKIN_KEY)));
      postThemeMessage(isDark(), getSkin());
    }
  });

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ave-theme') {
      if (typeof e.data.dark === 'boolean') localStorage.setItem(THEME_KEY, e.data.dark ? 'dark' : 'light');
      if (e.data.skin) localStorage.setItem(SKIN_KEY, normalizeSkin(e.data.skin));
      applyTheme(localStorage.getItem(THEME_KEY) === 'dark', normalizeSkin(localStorage.getItem(SKIN_KEY)));
      postThemeMessage(isDark(), getSkin());
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();

  window.toggleAveTheme = toggleFromEvent;

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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setInvertedFavicon);
  else setInvertedFavicon();
})();
