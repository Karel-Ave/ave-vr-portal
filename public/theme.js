(function () {
  var THEME_KEY = 'ave-portal-theme';
  var SKIN_KEY = 'ave-portal-skin';
  var LIGHT_SKIN_KEY = 'ave-portal-skin-light';
  var DARK_SKIN_KEY = 'ave-portal-skin-dark';
  var USER_KEY = 'ave-portal-theme-user';
  var DEFAULT_LIGHT_SKIN = 'indigo';
  var DEFAULT_DARK_SKIN = 'green';
  var SKINS = [
    { id: 'graphite', label: 'Grafit' },
    { id: 'slate', label: 'Slate' },
    { id: 'blue', label: 'Modra' },
    { id: 'teal', label: 'Teal' },
    { id: 'green', label: 'Zelena' },
    { id: 'olive', label: 'Oliva' },
    { id: 'amber', label: 'Amber' },
    { id: 'rose', label: 'Rose' },
    { id: 'violet', label: 'Violet' },
    { id: 'indigo', label: 'Indigo' },
    { id: 'cyan', label: 'Cyan' },
    { id: 'mint', label: 'Mint' },
    { id: 'lime', label: 'Lime' },
    { id: 'yellow', label: 'Zluta' },
    { id: 'orange', label: 'Oranzova' },
    { id: 'red', label: 'Cervena' },
    { id: 'pink', label: 'Pink' },
    { id: 'plum', label: 'Plum' },
    { id: 'coffee', label: 'Coffee' },
    { id: 'navy', label: 'Navy' },
    { id: 'default', label: 'Klasicky' }
  ];
  var SKIN_IDS = SKINS.map(function (s) { return s.id; });
  var lastThemeToggle = 0;
  var lastThemeEventAt = 0;
  var lastLocalThemeChange = 0;
  var bootStartedAt = Date.now();

  function normalizeSkin(skin, fallback) {
    fallback = fallback || DEFAULT_LIGHT_SKIN;
    skin = String(skin || fallback).toLowerCase();
    if (skin === 'mono') skin = 'default';
    return SKIN_IDS.indexOf(skin) >= 0 ? skin : fallback;
  }

  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function getSkinForMode(dark) {
    var key = dark ? DARK_SKIN_KEY : LIGHT_SKIN_KEY;
    var fallback = dark ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN;
    return normalizeSkin(localStorage.getItem(key), fallback);
  }

  function defaultSkinForMode(dark) {
    return dark ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN;
  }

  function getSkinChoices(dark) {
    var defaultId = defaultSkinForMode(!!dark);
    var choices = [{ id: defaultId, label: 'Vychozi' }];
    SKINS.forEach(function (skin) {
      if (skin.id !== defaultId) choices.push(skin);
    });
    return choices;
  }

  function getSkin() {
    return normalizeSkin(
      document.documentElement.getAttribute('data-skin') ||
      localStorage.getItem(SKIN_KEY) ||
      getSkinForMode(isDark()),
      isDark() ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN
    );
  }

  function applyTheme(dark, skin) {
    skin = normalizeSkin(skin || getSkinForMode(dark), dark ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN);
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    document.documentElement.setAttribute('data-skin', skin);
    localStorage.setItem(SKIN_KEY, skin);
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
        body: JSON.stringify({
          theme: dark ? 'dark' : 'light',
          skin: normalizeSkin(skin, dark ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN),
          theme_skin_light: getSkinForMode(false),
          theme_skin_dark: getSkinForMode(true)
        })
      }).catch(function () {});
    } catch (e) {}
  }

  function setThemeMode(dark, persist) {
    var skin = getSkinForMode(dark);
    if (persist !== false) lastLocalThemeChange = Date.now();
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    applyTheme(dark, skin);
    postThemeMessage(dark, skin);
    if (persist !== false) saveToServer(dark, skin);
  }

  function setSkin(skin, persist) {
    var dark = isDark();
    var key = dark ? DARK_SKIN_KEY : LIGHT_SKIN_KEY;
    skin = normalizeSkin(skin, dark ? DEFAULT_DARK_SKIN : DEFAULT_LIGHT_SKIN);
    if (persist !== false) lastLocalThemeChange = Date.now();
    localStorage.setItem(key, skin);
    localStorage.setItem(SKIN_KEY, skin);
    applyTheme(dark, skin);
    postThemeMessage(dark, skin);
    if (persist !== false) saveToServer(dark, skin);
  }

  function toggleThemeNow() {
    if (Date.now() - lastThemeToggle < 250) return false;
    lastThemeToggle = Date.now();
    setThemeMode(!isDark(), true);
    return false;
  }

  function toggleFromEvent(e) {
    var now = Date.now();
    if (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (now - lastThemeEventAt < 650) return false;
    }
    lastThemeEventAt = now;
    return toggleThemeNow();
  }

  function seedLocalDefaults() {
    if (!localStorage.getItem(LIGHT_SKIN_KEY)) localStorage.setItem(LIGHT_SKIN_KEY, DEFAULT_LIGHT_SKIN);
    if (!localStorage.getItem(DARK_SKIN_KEY)) localStorage.setItem(DARK_SKIN_KEY, DEFAULT_DARK_SKIN);
  }

  seedLocalDefaults();
  applyTheme(localStorage.getItem(THEME_KEY) === 'dark', getSkinForMode(localStorage.getItem(THEME_KEY) === 'dark'));

  window.AVE_THEME_SKINS = SKINS;
  window.AVE_THEME = {
    apply: applyTheme,
    isDark: isDark,
    getSkin: getSkin,
    getSkinForMode: getSkinForMode,
    defaultSkinForMode: defaultSkinForMode,
    getSkinChoices: getSkinChoices,
    setMode: setThemeMode,
    setSkin: setSkin,
    toggle: toggleThemeNow,
    skins: SKINS
  };

  function setup() {
    var btn = document.getElementById('btn-theme');
    if (btn && !btn.dataset.themeBound) {
      btn.dataset.themeBound = '1';
      btn.textContent = isDark() ? '☀️' : '🌙';
      btn.style.touchAction = 'manipulation';
      btn.style.webkitTapHighlightColor = 'transparent';
      function toggleThemeButton(e) {
        return toggleFromEvent(e);
      }
      btn.addEventListener('pointerdown', toggleThemeButton, { passive: false });
      btn.addEventListener('touchstart', toggleThemeButton, { passive: false });
      btn.addEventListener('click', toggleThemeButton, { passive: false });
    }

    fetch('/api/me', { credentials: 'include' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (user) {
      if (!user) return;
      var serverDark = user.theme === 'dark';
      var lightSkin = normalizeSkin(user.theme_skin_light || (!serverDark && user.theme_skin) || DEFAULT_LIGHT_SKIN, DEFAULT_LIGHT_SKIN);
      var darkSkin = normalizeSkin(user.theme_skin_dark || (serverDark && user.theme_skin) || DEFAULT_DARK_SKIN, DEFAULT_DARK_SKIN);
      var userKey = String(user.id || user.username || '');

      if (lastLocalThemeChange >= bootStartedAt) return;
      localStorage.setItem(USER_KEY, userKey);
      localStorage.setItem(THEME_KEY, serverDark ? 'dark' : 'light');
      localStorage.setItem(LIGHT_SKIN_KEY, lightSkin);
      localStorage.setItem(DARK_SKIN_KEY, darkSkin);
      applyTheme(serverDark, serverDark ? darkSkin : lightSkin);
      postThemeMessage(serverDark, serverDark ? darkSkin : lightSkin);
    }).catch(function () {});
  }

  window.addEventListener('storage', function (e) {
    if ([THEME_KEY, SKIN_KEY, LIGHT_SKIN_KEY, DARK_SKIN_KEY].indexOf(e.key) >= 0) {
      var dark = localStorage.getItem(THEME_KEY) === 'dark';
      applyTheme(dark, getSkinForMode(dark));
      postThemeMessage(isDark(), getSkin());
    }
  });

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ave-theme') {
      lastLocalThemeChange = Date.now();
      if (typeof e.data.dark === 'boolean') localStorage.setItem(THEME_KEY, e.data.dark ? 'dark' : 'light');
      if (e.data.skin) {
        var dark = localStorage.getItem(THEME_KEY) === 'dark';
        var normalizedSkin = normalizeSkin(e.data.skin, defaultSkinForMode(dark));
        localStorage.setItem(dark ? DARK_SKIN_KEY : LIGHT_SKIN_KEY, normalizedSkin);
        localStorage.setItem(SKIN_KEY, normalizedSkin);
      }
      var modeDark = localStorage.getItem(THEME_KEY) === 'dark';
      applyTheme(modeDark, getSkinForMode(modeDark));
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
