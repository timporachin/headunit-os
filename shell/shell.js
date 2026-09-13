/*
 * The shell.
 *
 * Holds the chrome, the launcher, and one iframe per opened app. Apps are
 * cross-origin on purpose (each owns its port), so everything that crosses the
 * boundary crosses it as a postMessage on the "headunit" channel — see
 * sdk/headunit.js for the app's half.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    shell: $('shell'), stage: $('stage'), rail: $('rail'), railApps: $('railApps'),
    railTab: $('railTab'), launcher: $('launcher'),
    empty: $('launcherEmpty'), errors: $('registryErrors'),
    sceneBackdrop: $('sceneBackdrop'), truckHotspot: $('truckHotspot'),
    radialMenu: $('radialMenu'), sceneHint: $('sceneHint'),
    frames: $('frames'), boot: $('boot'), bootName: $('bootName'), bootNote: $('bootNote'),
    failure: $('failure'), failName: $('failName'), failWhy: $('failWhy'), failLog: $('failLog'),
    statusTitle: $('statusTitle'), statusState: $('statusState'),
    clock: $('clock'), themeBtn: $('themeBtn'), themeGlyph: $('themeGlyph'),
    toasts: $('toasts'), dimmer: $('dimmer'),
    settings: $('settings'), settingsBtn: $('settingsBtn'), settingsDone: $('settingsDone'),
    themeMode: $('themeMode'), themeHint: $('themeHint'),
    brightness: $('brightness'), brightnessValue: $('brightnessValue'),
    speedUnit: $('speedUnit'), tempUnit: $('tempUnit'),
    vehicleName: $('vehicleName'), keepAwake: $('keepAwake'), wakeHint: $('wakeHint'),
    lat: $('lat'), lon: $('lon'), useGps: $('useGps'),
    clearLocation: $('clearLocation'), locationHint: $('locationHint'),
    appRows: $('appRows'), settingsLog: $('settingsLog'), reloadRegistry: $('reloadRegistry'),
  };

  /* The single source of truth for vehicle telemetry. Nothing is wired to a
   * real vehicle yet, so this says so rather than reporting a plausible zero:
   * a speed on a driver's screen has to be a measurement or an admission. */
  const vehicle = { speed: null, unit: 'mph', gear: null, parked: true, source: 'unavailable' };

  /** id -> { app, frame, connected } for every app that has been opened. */
  const opened = new Map();
  let apps = [];
  let currentId = null;

  /* ── Settings ───────────────────────────────────────────── */
  /*
   * Preferences the shell owns, because every one of them changes the shell
   * itself: the name in the status bar, the dimmer that has to paint over an
   * app's frame, the units the SDK reports. None of that is reachable from
   * inside an app's own origin, which is why settings is chrome and not an app.
   */
  const SETTINGS_KEY = 'headunit.settings';
  const LEGACY_THEME_KEY = 'headunit.theme';
  const THEME_MODES = ['night', 'day', 'auto'];
  const SPEED_UNITS = ['mph', 'km/h'];
  const TEMP_UNITS = ['F', 'C'];
  const MIN_BRIGHTNESS = 25;
  const MAX_NAME = 24;
  const NO_LOCATION_HINT = 'Used for sunrise and sunset, and by the weather screen.';

  const DEFAULTS = {
    themeMode: 'night',
    brightness: 100,
    units: { speed: 'mph', temp: 'F' },
    vehicleName: 'F-250',
    keepAwake: false,
    location: null,
  };

  const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** Read stored settings. Whatever is in storage is whatever was written there
   *  last — by an older build, or by hand — so every field is validated. */
  function loadSettings() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch { /* absent or corrupt; the defaults below stand in */ }

    let themeMode = oneOf(stored.themeMode, THEME_MODES, null);
    if (!themeMode) {
      // The theme used to live under a key of its own. Carry it across once, so
      // a head unit already set to day does not silently revert to night.
      themeMode = oneOf(localStorage.getItem(LEGACY_THEME_KEY), THEME_MODES, DEFAULTS.themeMode);
    }

    const loc = stored.location;
    const usableLoc = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
      && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180;

    return {
      themeMode,
      brightness: clamp(Number(stored.brightness) || DEFAULTS.brightness, MIN_BRIGHTNESS, 100),
      units: {
        speed: oneOf(stored.units?.speed, SPEED_UNITS, DEFAULTS.units.speed),
        temp: oneOf(stored.units?.temp, TEMP_UNITS, DEFAULTS.units.temp),
      },
      vehicleName: String(stored.vehicleName ?? '').trim().slice(0, MAX_NAME) || DEFAULTS.vehicleName,
      keepAwake: stored.keepAwake === true,
      location: usableLoc ? { lat: loc.lat, lon: loc.lon } : null,
    };
  }

  let settings = loadSettings();

  /** Persist, re-apply everything a setting drives, and tell the open apps. */
  function commit() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
    catch { toast('Could not save settings: this browser is refusing storage.', 'warn'); }
    applyBrightness();
    applyResolvedTheme();
    vehicle.unit = settings.units.speed;
    if (!currentId) setStatus(settings.vehicleName, null);
    broadcastSettings();
    renderSettings();
  }

  /* What an app is allowed to see. Brightness and the wake lock are the shell's
   * own business and an app has no use for either, so they do not travel. */
  function publicSettings() {
    return {
      units: { ...settings.units },
      vehicleName: settings.vehicleName,
      location: settings.location ? { ...settings.location } : null,
    };
  }

  function broadcastSettings() {
    for (const { frame } of opened.values()) send(frame, 'settings', publicSettings());
  }

  /* ── Theme ──────────────────────────────────────────────── */
  /* `settings.themeMode` is the preference; `theme` is what is actually
   * painted. Under "auto" the second is derived from the sun, so it is never
   * stored — storing it would freeze a decision that has to keep moving. */
  let theme = 'night';

  function applyTheme(next) {
    const changed = next !== theme;
    theme = next;
    document.documentElement.setAttribute('data-theme', theme);
    el.themeGlyph.textContent = theme === 'night' ? '☾' : '☀';
    // Apps that loaded the SDK follow the shell rather than guessing.
    if (changed) for (const { frame } of opened.values()) send(frame, 'theme', { theme });
  }

  /*
   * Sunrise and sunset, by the NOAA solar equations.
   *
   * Arithmetic only, deliberately: a truck parked in a canyon with no signal
   * still has to know when it gets dark. `lon` is east-positive, as everything
   * else in this OS uses it. Returns null above the polar circles on the days
   * the sun never crosses the horizon — there is no time to report there, and
   * inventing one would hold the screen in the wrong mode for a month.
   */
  function sunTimes(date, lat, lon) {
    const rad = Math.PI / 180;
    const lw = -lon;
    const jdate = date.getTime() / 86400000 + 2440587.5;
    const n = Math.round(jdate - 2451545.0 - 0.0009 - lw / 360);
    const jStar = n + 0.0009 + lw / 360;
    const M = (357.5291 + 0.98560028 * jStar) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const lambda = (M + C + 180 + 102.9372) % 360;
    const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
    const decl = Math.asin(Math.sin(lambda * rad) * Math.sin(23.44 * rad));
    // -0.833° rather than 0: the sun's own radius, plus atmospheric refraction.
    const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl))
               / (Math.cos(lat * rad) * Math.cos(decl));
    if (cosW < -1 || cosW > 1) return null;
    const w = Math.acos(cosW) / rad;
    const toDate = (j) => new Date((j - 2440587.5) * 86400000);
    return { sunrise: toDate(jTransit - w / 360), sunset: toDate(jTransit + w / 360) };
  }

  const fmtTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /** The theme to paint right now, and the reason, for the settings screen. */
  function resolveTheme(now = new Date()) {
    if (settings.themeMode !== 'auto') return { theme: settings.themeMode, why: '' };

    if (settings.location) {
      const t = sunTimes(now, settings.location.lat, settings.location.lon);
      if (!t) {
        return { theme: 'night', why: 'The sun neither rises nor sets at this latitude today, so this holds night.' };
      }
      const daylight = now >= t.sunrise && now < t.sunset;
      return { theme: daylight ? 'day' : 'night', why: `Sunrise ${fmtTime(t.sunrise)}, sunset ${fmtTime(t.sunset)}.` };
    }

    const hour = now.getHours();
    return {
      theme: hour >= 7 && hour < 19 ? 'day' : 'night',
      why: 'No home location set, so this falls back to a flat 07:00–19:00 rather than guessing where the truck is.',
    };
  }

  function applyResolvedTheme() {
    const { theme: next, why } = resolveTheme();
    applyTheme(next);
    el.themeHint.textContent = settings.themeMode === 'auto' ? why : '';
  }

  // Auto has to keep up with the clock, not only with taps.
  setInterval(() => { if (settings.themeMode === 'auto') applyResolvedTheme(); }, 60_000);

  el.themeBtn.addEventListener('click', () => {
    // The status-bar chip names a theme outright, which also steps out of auto
    // rather than being quietly overruled by it a minute later.
    settings.themeMode = theme === 'night' ? 'day' : 'night';
    commit();
  });

  /* ── Brightness ─────────────────────────────────────────── */
  /* 100 is clear glass, 25 is three-quarters black. The floor is also on the
   * input's own min attribute, so the panel can never be dimmed to the point
   * where you can no longer find the control that dimmed it. */
  function applyBrightness() {
    el.dimmer.style.opacity = String((100 - settings.brightness) / 100);
  }

  /* ── Keeping the screen awake ───────────────────────────── */
  let wakeSentinel = null;

  async function applyWakeLock() {
    if (!('wakeLock' in navigator)) {
      el.wakeHint.textContent = 'This browser has no screen wake lock, so the display follows the system power settings.';
      return;
    }
    if (settings.keepAwake && !wakeSentinel) {
      try {
        wakeSentinel = await navigator.wakeLock.request('screen');
        wakeSentinel.addEventListener('release', () => { wakeSentinel = null; }, { once: true });
        el.wakeHint.textContent = 'Holding the screen on.';
      } catch (err) {
        el.wakeHint.textContent = `Could not hold the screen on: ${err.message}`;
      }
    } else if (!settings.keepAwake && wakeSentinel) {
      try { await wakeSentinel.release(); } catch { /* already released */ }
      wakeSentinel = null;
      el.wakeHint.textContent = '';
    }
  }

  /* The browser drops a wake lock whenever the page is hidden — a screensaver,
   * the kiosk minimised, the machine locked — and never takes it back on its
   * own. Ask again on every return to visible. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && settings.keepAwake) applyWakeLock();
  });

  /* ── Clock ──────────────────────────────────────────────── */
  const tick = () => {
    el.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 10_000);

  /* ── Toasts ─────────────────────────────────────────────── */
  function toast(message, tone = 'info') {
    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.tone = tone;
    node.textContent = message;
    el.toasts.append(node);
    setTimeout(() => node.remove(), 3600);
  }

  /* ── Views ──────────────────────────────────────────────── */
  function show(view) {
    el.shell.dataset.view = view;
    el.launcher.hidden = view !== 'launcher';
    el.frames.hidden = view !== 'app';
    el.boot.hidden = view !== 'boot';
    el.failure.hidden = view !== 'failure';
    el.settings.hidden = view !== 'settings';
  }

  function setImmersive(on) {
    el.shell.dataset.immersive = String(Boolean(on));
    el.railTab.hidden = !on;
  }
  el.railTab.addEventListener('click', () => setImmersive(false));

  function setStatus(title, state) {
    title = title || settings.vehicleName;
    el.statusTitle.textContent = title;
    el.statusState.textContent = state || '';
    el.statusState.hidden = !state;
  }

  /* ── Registry ───────────────────────────────────────────── */
  async function refresh() {
    const res = await fetch('/api/apps');
    const data = await res.json();
    apps = data.apps;
    render(data.errors);
  }

  /*
   * Where each app sits on the arc.
   *
   * The mockup fixed five items across 190°-350°. Driving that off the item
   * count puts two apps at the extreme ends with a hole between them, so the
   * fan is built the other way round: a fixed step per item, centred straight
   * up from the truck. Two apps sit either side of centre; five reproduce the
   * mockup's spread; more widen it until the span is capped.
   */
  const RADIUS = 132;
  const MIN_GAP = 156;   // centre-to-centre, in px, so labels cannot collide
  const MAX_SPAN = 300;

  /* The angle that puts two neighbours MIN_GAP apart on a circle of RADIUS.
   * Spacing by a fixed angle looked right until it was drawn: at 42° the two
   * items sat 94px apart and their labels ran together into one line. Distance
   * is what actually has to be preserved, so solve for the angle instead. */
  const gapStep = 2 * Math.asin(Math.min(1, MIN_GAP / (2 * RADIUS))) * 180 / Math.PI;

  function placeOnArc(index, count) {
    // Past a certain count the ring runs out of room and the cap wins; the
    // label's own ellipsis covers what the spacing then cannot.
    const step = count > 1 ? Math.min(gapStep, MAX_SPAN / (count - 1)) : gapStep;
    // 270° is straight up: screen y grows downward, so sin() is negative there.
    const angle = (270 + (index - (count - 1) / 2) * step) * Math.PI / 180;
    return { dx: RADIUS * Math.cos(angle), dy: RADIUS * Math.sin(angle) };
  }

  /* An app may ship inline SVG for its icon; otherwise its emoji is used.
   * Manifests are local config that already names a command to execute, so
   * markup from one is not a new trust boundary. */
  const iconMarkup = (app) => app.iconSvg || `<span class="glyph">${escape(app.icon)}</span>`;

  function render(errors = []) {
    el.radialMenu.replaceChildren();
    el.railApps.replaceChildren();
    el.empty.hidden = apps.length > 0;

    apps.forEach((app, index) => {
      const running = opened.has(app.id) || app.state === 'ready';
      const { dx, dy } = placeOnArc(index, apps.length);

      const item = document.createElement('button');
      item.className = 'radial-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.running = String(running);
      item.style.setProperty('--dx', `${dx.toFixed(1)}px`);
      item.style.setProperty('--dy', `${dy.toFixed(1)}px`);
      // Staggered so they bloom rather than appear together.
      item.style.transitionDelay = `${index * 45}ms`;
      item.setAttribute('aria-label', app.name);
      item.innerHTML = `${iconMarkup(app)}<span class="rlabel">${escape(app.name)}</span>`;
      item.addEventListener('click', (event) => { event.stopPropagation(); closeMenu(); open(app.id); });

      if (running) {
        const stop = document.createElement('button');
        stop.className = 'radial-stop';
        stop.textContent = '\u00d7';
        stop.setAttribute('aria-label', `Stop ${app.name}`);
        stop.addEventListener('click', (event) => { event.stopPropagation(); stopApp(app.id); });
        item.append(stop);
      }
      el.radialMenu.append(item);

      const railItem = document.createElement('button');
      railItem.className = 'rail-item';
      railItem.dataset.running = String(running);
      if (app.id === currentId) railItem.setAttribute('aria-current', 'true');
      railItem.setAttribute('aria-label', app.name);
      railItem.title = app.name;
      railItem.innerHTML = `<span class="glyph">${iconMarkup(app)}</span>`;
      railItem.addEventListener('click', () => open(app.id));
      el.railApps.append(railItem);
    });

    el.errors.hidden = errors.length === 0;
    el.errors.textContent = errors.join('\n');
    renderAppRows();
  }

  /* ── The radial menu ────────────────────────────────────── */

  function openMenu() {
    if (!apps.length) return;
    el.radialMenu.classList.add('open');
    el.truckHotspot.classList.add('open');
    el.truckHotspot.setAttribute('aria-expanded', 'true');
    el.sceneBackdrop.classList.add('open');
    el.sceneHint.classList.add('hidden');
  }

  function closeMenu() {
    el.radialMenu.classList.remove('open');
    el.truckHotspot.classList.remove('open');
    el.truckHotspot.setAttribute('aria-expanded', 'false');
    el.sceneBackdrop.classList.remove('open');
    el.sceneHint.classList.remove('hidden');
  }

  /* A wave out from the truck on every tap. The node removes itself when the
   * animation ends, so hammering the hotspot cannot pile up elements. */
  function ripple() {
    const wave = document.createElement('span');
    wave.className = 'ripple';
    wave.addEventListener('animationend', () => wave.remove(), { once: true });
    // Behind the menu items, in front of the photograph.
    el.truckHotspot.parentElement.insertBefore(wave, el.truckHotspot);
    // A safety net: if the animation never fires an end event — reduced motion
    // stills it — the node still goes rather than lingering forever.
    setTimeout(() => wave.remove(), 1500);
  }

  el.truckHotspot.addEventListener('click', (event) => {
    event.stopPropagation();
    ripple();
    if (el.radialMenu.classList.contains('open')) closeMenu();
    else openMenu();
  });
  el.sceneBackdrop.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (el.shell.dataset.view === 'settings') closeSettings();
    else closeMenu();
  });

  /** Stop an app and drop its frame, so reopening it is a clean boot. */
  async function stopApp(id) {
    const entry = opened.get(id);
    entry?.frame.remove();
    opened.delete(id);
    if (currentId === id) currentId = null;
    try {
      await fetch(`/api/apps/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    } catch { /* the app is gone from the UI either way */ }
    await refresh();
  }


  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ── Opening an app ─────────────────────────────────────── */
  async function open(id) {
    const app = apps.find((a) => a.id === id);
    if (!app) return;

    // Already open: just bring it forward. The frame stayed alive in the
    // background, so there is no second boot to pay for.
    if (opened.has(id)) return foreground(id);

    currentId = id;
    setStatus(app.name, 'starting');
    el.bootName.textContent = app.name;
    el.bootNote.textContent = app.kind === 'process'
      ? 'Starting its server and waiting for it to answer…'
      : 'Opening…';
    show('boot');
    render();

    let info;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(id)}/start`, { method: 'POST' });
      info = await res.json();
    } catch (err) {
      info = { state: 'failed', error: `the shell could not reach its own control plane: ${err.message}` };
    }

    if (info.state !== 'ready' || !info.url) return showFailure(app, info.error);

    const frame = document.createElement('iframe');
    frame.src = info.url;
    frame.title = app.name;
    // A third-party app is not trusted with our origin. It gets what it needs
    // to be a real page and nothing that reaches back into the shell.
    frame.setAttribute('allow', 'geolocation; microphone; camera; fullscreen; xr-spatial-tracking');
    el.frames.append(frame);
    opened.set(id, { app, frame, connected: false });

    foreground(id);
    if (app.immersive) setImmersive(true);
  }

  function foreground(id) {
    currentId = id;
    for (const [otherId, entry] of opened) {
      const visible = otherId === id;
      entry.frame.hidden = !visible;
      send(entry.frame, 'visibility', { visible });
    }
    const { app } = opened.get(id);
    setStatus(app.name, null);
    setImmersive(app.immersive);
    show('app');
    render();
  }

  function home() {
    currentId = null;
    for (const entry of opened.values()) {
      entry.frame.hidden = true;
      send(entry.frame, 'visibility', { visible: false });
    }
    setImmersive(false);
    setStatus(settings.vehicleName, null);
    closeMenu();
    show('launcher');
    refresh();
  }
  $('homeBtn').addEventListener('click', home);
  $('failHomeBtn').addEventListener('click', home);

  async function showFailure(app, why) {
    setStatus(app.name, 'failed');
    el.failName.textContent = `${app.name} could not start`;
    el.failWhy.textContent = why || 'The app stopped before it served anything.';
    el.failLog.textContent = 'Loading output…';
    show('failure');
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}/logs`);
      const { lines } = await res.json();
      el.failLog.textContent = lines.length ? lines.join('\n') : '(the app produced no output)';
    } catch {
      el.failLog.textContent = '(could not read the app output)';
    }
    $('retryBtn').onclick = () => { opened.delete(app.id); open(app.id); };
  }

  /* ── The bridge ─────────────────────────────────────────── */
  function send(frame, type, payload, replyTo) {
    try {
      frame.contentWindow?.postMessage({ channel: 'headunit', protocol: 1, type, payload, replyTo }, '*');
    } catch { /* a frame that navigated away is not an error worth surfacing */ }
  }

  function entryForSource(source) {
    for (const entry of opened.values()) if (entry.frame.contentWindow === source) return entry;
    return null;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.channel !== 'headunit') return;

    // Trust the frame we are actually hosting, identified by its window object
    // rather than by anything it claims about itself.
    const entry = entryForSource(event.source);
    if (!entry) return;
    const reply = (payload) => send(entry.frame, 'reply', payload, msg.id);

    switch (msg.type) {
      case 'hello':
        entry.connected = true;
        send(entry.frame, 'welcome', {
          app: { id: entry.app.id, name: entry.app.name },
          theme,
          vehicle,
          settings: publicSettings(),
        });
        break;
      case 'setTitle':
        if (entry.app.id === currentId) setStatus(String(msg.payload?.title || entry.app.name), null);
        break;
      case 'setImmersive':
        if (entry.app.id === currentId) setImmersive(msg.payload?.immersive !== false);
        break;
      case 'open':
        open(String(msg.payload?.appId || ''));
        break;
      case 'home':
        home();
        break;
      case 'toast':
        toast(String(msg.payload?.message || ''), msg.payload?.tone);
        break;
      case 'listApps':
        reply({ apps: apps.map(({ id, name, icon, kind }) => ({ id, name, icon, kind })) });
        break;
    }
  });

  /* ── The settings screen ────────────────────────────────── */

  function setSegment(group, value) {
    for (const button of group.querySelectorAll('button[role="radio"]')) {
      button.setAttribute('aria-checked', String(button.dataset.value === value));
    }
  }

  function onSegment(group, apply) {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[role="radio"]');
      if (!button) return;
      apply(button.dataset.value);
      commit();
    });
  }

  onSegment(el.themeMode, (value) => { settings.themeMode = value; });
  onSegment(el.speedUnit, (value) => { settings.units.speed = value; });
  onSegment(el.tempUnit, (value) => { settings.units.temp = value; });

  /* Paint on every frame of the drag so the slider feels attached to the
   * screen, but only write storage once it settles. */
  el.brightness.addEventListener('input', () => {
    settings.brightness = clamp(Number(el.brightness.value), MIN_BRIGHTNESS, 100);
    el.brightnessValue.textContent = `${settings.brightness}%`;
    applyBrightness();
  });
  el.brightness.addEventListener('change', commit);

  el.vehicleName.addEventListener('input', () => {
    settings.vehicleName = el.vehicleName.value.trim().slice(0, MAX_NAME) || DEFAULTS.vehicleName;
    if (!currentId) setStatus(settings.vehicleName, null);
  });
  el.vehicleName.addEventListener('change', commit);

  el.keepAwake.addEventListener('click', () => {
    settings.keepAwake = el.keepAwake.getAttribute('aria-checked') !== 'true';
    commit();
    applyWakeLock();
  });

  /* Two free-text fields, so nothing here trusts them. An empty pair means "no
   * home location", which is a real answer and not an error. */
  function readLocationFields() {
    const rawLat = el.lat.value.trim();
    const rawLon = el.lon.value.trim();
    if (!rawLat && !rawLon) return { ok: true, location: null };
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!rawLat || !rawLon || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { ok: false, why: 'Both fields need a number.' };
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, why: 'Latitude runs to ±90 and longitude to ±180.' };
    }
    return { ok: true, location: { lat, lon } };
  }

  function commitLocation() {
    const result = readLocationFields();
    if (!result.ok) { el.locationHint.textContent = result.why; return; }
    settings.location = result.location;
    el.locationHint.textContent = settings.location
      ? 'Saved. Sunrise and sunset are computed from here.'
      : NO_LOCATION_HINT;
    commit();
  }
  el.lat.addEventListener('change', commitLocation);
  el.lon.addEventListener('change', commitLocation);

  el.useGps.addEventListener('click', () => {
    if (!navigator.geolocation) {
      el.locationHint.textContent = 'This browser offers no geolocation, so type a position in instead.';
      return;
    }
    el.locationHint.textContent = 'Asking the browser where we are…';
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        settings.location = {
          lat: Number(coords.latitude.toFixed(4)),
          lon: Number(coords.longitude.toFixed(4)),
        };
        el.locationHint.textContent = `Set from GPS, to about ${Math.round(coords.accuracy)} m.`;
        commit();
      },
      (err) => { el.locationHint.textContent = `The browser would not give a position: ${err.message}`; },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });

  el.clearLocation.addEventListener('click', () => {
    settings.location = null;
    el.locationHint.textContent = NO_LOCATION_HINT;
    commit();
  });

  /** Push the current settings back into the controls that display them. */
  function renderSettings() {
    setSegment(el.themeMode, settings.themeMode);
    setSegment(el.speedUnit, settings.units.speed);
    setSegment(el.tempUnit, settings.units.temp);
    el.brightness.value = String(settings.brightness);
    el.brightnessValue.textContent = `${settings.brightness}%`;
    el.keepAwake.setAttribute('aria-checked', String(settings.keepAwake));
    // Never overwrite a field somebody is part-way through typing into.
    if (document.activeElement !== el.vehicleName) el.vehicleName.value = settings.vehicleName;
    if (document.activeElement !== el.lat) el.lat.value = settings.location ? String(settings.location.lat) : '';
    if (document.activeElement !== el.lon) el.lon.value = settings.location ? String(settings.location.lon) : '';
  }

  /*
   * The apps panel. Everything here drives endpoints the control plane already
   * has, so this adds no server surface — and it is the way to recover an app
   * that is wedged, or to read why one failed, without hunting for its badge
   * on the launcher's arc.
   */
  function renderAppRows() {
    el.appRows.replaceChildren();
    if (!apps.length) {
      const empty = document.createElement('p');
      empty.className = 'app-empty';
      empty.textContent = 'No apps installed. Add one at apps/<id>/app.json, then reload the registry.';
      el.appRows.append(empty);
      return;
    }

    for (const app of apps) {
      const busy = app.state === 'ready' || app.state === 'starting';
      const row = document.createElement('div');
      row.className = 'app-row';
      row.innerHTML =
        `<span class="aicon">${iconMarkup(app)}</span>`
        + `<span class="aname">${escape(app.name)}</span>`
        + `<span class="astate" data-state="${escape(app.state)}">${escape(app.state)}</span>`;

      const act = document.createElement('button');
      act.textContent = busy ? 'Stop' : 'Start';
      act.addEventListener('click', async () => {
        act.disabled = true;
        act.textContent = busy ? 'Stopping…' : 'Starting…';
        if (busy) {
          await stopApp(app.id);
        } else {
          try {
            const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}/start`, { method: 'POST' });
            const info = await res.json();
            if (info.state === 'failed') toast(`${app.name}: ${info.error}`, 'alert');
          } catch (err) {
            toast(`Could not reach the control plane: ${err.message}`, 'alert');
          }
          await refresh();
        }
      });

      const log = document.createElement('button');
      log.className = 'ghost';
      log.textContent = 'Log';
      log.addEventListener('click', () => showLog(app));

      row.append(act, log);
      el.appRows.append(row);
    }
  }

  async function showLog(app) {
    el.settingsLog.hidden = false;
    el.settingsLog.textContent = `Reading ${app.name}…`;
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}/logs`);
      const { lines } = await res.json();
      el.settingsLog.textContent = lines.length
        ? `${app.name}\n\n${lines.join('\n')}`
        : `${app.name} has produced no output.`;
    } catch (err) {
      el.settingsLog.textContent = `Could not read ${app.name}: ${err.message}`;
    }
  }

  el.reloadRegistry.addEventListener('click', async () => {
    try {
      await fetch('/api/reload', { method: 'POST' });
      await refresh();
      toast('Registry reloaded.');
    } catch (err) {
      toast(`Could not reload the registry: ${err.message}`, 'alert');
    }
  });

  /* Settings is reached from the status bar and returns wherever it came from,
   * so opening it from inside an app does not dump you back at the launcher. */
  let viewBeforeSettings = 'launcher';

  function openSettings() {
    viewBeforeSettings = el.shell.dataset.view;
    renderSettings();
    show('settings');
    setStatus('Settings', null);
    refresh().catch(() => { /* the panel still works; the app list just stays stale */ });
  }

  function closeSettings() {
    if (viewBeforeSettings === 'app' && currentId && opened.has(currentId)) foreground(currentId);
    else home();
  }

  el.settingsBtn.addEventListener('click', () => {
    if (el.shell.dataset.view === 'settings') closeSettings();
    else openSettings();
  });
  el.settingsDone.addEventListener('click', closeSettings);

  /* ── Go ─────────────────────────────────────────────────── */
  applyBrightness();
  applyResolvedTheme();
  renderSettings();
  applyWakeLock();
  vehicle.unit = settings.units.speed;
  setStatus(settings.vehicleName, null);
  refresh().catch((err) => toast(`Could not load the app registry: ${err.message}`, 'alert'));
})();
