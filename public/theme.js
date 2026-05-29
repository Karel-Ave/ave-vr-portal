(function () {
  var THEME_KEY = 'ave-portal-theme';
  var SKIN_KEY = 'ave-portal-skin';
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: dark ? 'dark' : 'light', skin: normalizeSkin(skin) })
      }).catch(function () {});
    } catch (e) {}
  }

  function setThemeMode(dark, persist) {
    var skin = getSkin();
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    applyTheme(dark, skin);
    postThemeMessage(dark, skin);
    if (persist !== false) saveToServer(dark, skin);
  }

  function setSkin(skin, persist) {
    skin = normalizeSkin(skin);
    var dark = isDark();
    localStorage.setItem(SKIN_KEY, skin);
    applyTheme(dark, skin);
    postThemeMessage(dark, skin);
    if (persist !== false) saveToServer(dark, skin);
  }

  applyTheme(localStorage.getItem(THEME_KEY) === 'dark', normalizeSkin(localStorage.getItem(SKIN_KEY)));

  window.AVE_THEME_SKINS = SKINS;
  window.AVE_THEME = {
    apply: applyTheme,
    isDark: isDark,
    getSkin: getSkin,
    setMode: setThemeMode,
    setSkin: setSkin,
    skins: SKINS
  };

  function setup() {
    var btn = document.getElementById('btn-theme');
    if (btn) {
      btn.textContent = isDark() ? '☀️' : '🌙';
      var lastThemeTouch = 0;
      function toggleThemeButton(e) {
        if (e) e.preventDefault();
        if (e && e.type === 'click' && Date.now() - lastThemeTouch < 650) return;
        setThemeMode(!isDark(), true);
      }
      btn.addEventListener('touchend', function(e) {
        lastThemeTouch = Date.now();
        toggleThemeButton(e);
      }, { passive: false });
      btn.addEventListener('click', toggleThemeButton);
    }

    fetch('/api/me').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (user) {
      if (!user) return;
      var serverDark = user.theme === 'dark';
      var serverSkin = normalizeSkin(user.theme_skin || DEFAULT_SKIN);
      var localTheme = localStorage.getItem(THEME_KEY);
      var localSkin = localStorage.getItem(SKIN_KEY);

      if (localTheme === null) {
        localStorage.setItem(THEME_KEY, serverDark ? 'dark' : 'light');
        applyTheme(serverDark, localSkin || serverSkin);
      } else if (serverDark !== (localTheme === 'dark')) {
        saveToServer(localTheme === 'dark', normalizeSkin(localSkin || serverSkin));
      }

      if (localSkin === null) {
        localStorage.setItem(SKIN_KEY, serverSkin);
        applyTheme(localStorage.getItem(THEME_KEY) === 'dark', serverSkin);
      } else if (serverSkin !== normalizeSkin(localSkin)) {
        saveToServer(localStorage.getItem(THEME_KEY) === 'dark', localSkin);
      }
      postThemeMessage(isDark(), getSkin());
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
