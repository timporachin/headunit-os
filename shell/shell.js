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
    railTab: $('railTab'), launcher: $('launcher'), grid: $('appGrid'),
    empty: $('launcherEmpty'), errors: $('registryErrors'), sub: $('launcherSub'),
    frames: $('frames'), boot: $('boot'), bootName: $('bootName'), bootNote: $('bootNote'),
    failure: $('failure'), failName: $('failName'), failWhy: $('failWhy'), failLog: $('failLog'),
    statusTitle: $('statusTitle'), statusState: $('statusState'),
    clock: $('clock'), themeBtn: $('themeBtn'), themeGlyph: $('themeGlyph'),
    toasts: $('toasts'),
    heroGreet: $('heroGreet'), heroClock: $('heroClock'), heroDate: $('heroDate'),
    heroTime: $('heroTime'), heroMeridiem: $('heroMeridiem'),
    statApps: $('statApps'), statRunning: $('statRunning'), statVehicle: $('statVehicle'),
  };

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
  const greetingFor = (hour) => hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const tick = () => {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.clock.textContent = time;
    // A 24-hour locale yields no meridiem; the span then collapses via :empty.
    const [digits, meridiem = ''] = time.split(' ');
    el.heroTime.textContent = digits;
    el.heroMeridiem.textContent = meridiem;
    el.heroClock.dateTime = now.toISOString();
    el.heroDate.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    el.heroGreet.textContent = greetingFor(now.getHours());
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

  function render(errors = []) {
    el.grid.replaceChildren();
    el.railApps.replaceChildren();
    el.empty.hidden = apps.length > 0;
    el.sub.textContent = apps.length === 1 ? '1 app installed' : `${apps.length} apps installed`;

    for (const app of apps) {
      const running = opened.has(app.id) || app.state === 'ready';

      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.state = app.state;

      const openBtn = document.createElement('button');
      openBtn.className = 'tile-open';
      openBtn.innerHTML = `
        <span class="tile-icon">${escape(app.icon)}</span>
        <span class="tile-name">${escape(app.name)}</span>
        <span class="tile-desc">${escape(app.description)}</span>
        <span class="tile-foot"><span class="dot" data-state="${escape(app.state)}"></span>${escape(labelFor(app))}</span>`;
      openBtn.addEventListener('click', () => open(app.id));
      tile.append(openBtn);

      // Only a running app gets a stop control, so the launcher never offers an
      // action that would do nothing.
      if (running) {
        const stopBtn = document.createElement('button');
        stopBtn.className = 'tile-stop';
        stopBtn.title = `Stop ${app.name}`;
        stopBtn.setAttribute('aria-label', `Stop ${app.name}`);
        stopBtn.textContent = '\u00d7';
        stopBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          stopApp(app.id);
        });
        tile.append(stopBtn);
      }
      el.grid.append(tile);

      const item = document.createElement('button');
      item.className = 'rail-item';
      item.dataset.running = String(opened.has(app.id));
      if (app.id === currentId) item.setAttribute('aria-current', 'true');
      item.innerHTML = `<span class="glyph">${escape(app.icon)}</span><span class="label">${escape(app.name)}</span>`;
      item.addEventListener('click', () => open(app.id));
      el.railApps.append(item);
    }

    el.errors.hidden = errors.length === 0;
    el.errors.textContent = errors.join('\n');

    const running = apps.filter((a) => opened.has(a.id) || a.state === 'ready').length;
    el.statApps.textContent = String(apps.length);
    el.statRunning.textContent = String(running);
    el.statVehicle.textContent = vehicle.source === 'unavailable'
      ? 'no signal'
      : `${vehicle.speed ?? '--'} ${vehicle.unit}`;
  }

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

  const labelFor = (app) => ({
    ready: 'running', starting: 'starting', failed: 'failed', stopped: app.kind,
  }[app.state] || app.kind);

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
    setStatus('Home', null);
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
  setStatus('Home', null);
  refresh().catch((err) => toast(`Could not load the app registry: ${err.message}`, 'alert'));
})();
