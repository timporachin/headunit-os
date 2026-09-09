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
    toasts: $('toasts'),
  };

  /* The vehicle's name, shown in the status bar whenever no app is open. */
  const VEHICLE = 'F-250';

  /* The single source of truth for vehicle telemetry. Nothing is wired to a
   * real vehicle yet, so this says so rather than reporting a plausible zero:
   * a speed on a driver's screen has to be a measurement or an admission. */
  const vehicle = { speed: null, unit: 'mph', gear: null, parked: true, source: 'unavailable' };

  /** id -> { app, frame, connected } for every app that has been opened. */
  const opened = new Map();
  let apps = [];
  let currentId = null;
  let theme = localStorage.getItem('headunit.theme') || 'night';

  /* ── Theme ──────────────────────────────────────────────── */
  function applyTheme(next) {
    theme = next;
    document.documentElement.setAttribute('data-theme', theme);
    el.themeGlyph.textContent = theme === 'night' ? '☾' : '☀';
    localStorage.setItem('headunit.theme', theme);
    // Apps that loaded the SDK follow the shell rather than guessing.
    for (const { frame } of opened.values()) send(frame, 'theme', { theme });
  }
  el.themeBtn.addEventListener('click', () => applyTheme(theme === 'night' ? 'day' : 'night'));

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
  }

  function setImmersive(on) {
    el.shell.dataset.immersive = String(Boolean(on));
    el.railTab.hidden = !on;
  }
  el.railTab.addEventListener('click', () => setImmersive(false));

  function setStatus(title, state) {
    title = title || VEHICLE;
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

  el.truckHotspot.addEventListener('click', (event) => {
    event.stopPropagation();
    if (el.radialMenu.classList.contains('open')) closeMenu();
    else openMenu();
  });
  el.sceneBackdrop.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

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
    setStatus(VEHICLE, null);
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

  /* ── Go ─────────────────────────────────────────────────── */
  applyTheme(theme);
  setStatus(VEHICLE, null);
  refresh().catch((err) => toast(`Could not load the app registry: ${err.message}`, 'alert'));
})();
