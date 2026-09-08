/*
 * headunit.js — the optional bridge between a page and the shell.
 *
 *   <script src="http://localhost:4100/sdk/headunit.js"></script>
 *
 * Everything here is opt-in. An app that never loads this file still runs
 * perfectly as a page — that is the point of the design, and it is what lets
 * you drop somebody else's repo in without touching their code. Loading it
 * buys you theme sync, vehicle state, and the ability to drive the shell.
 *
 * The transport is postMessage, because apps are cross-origin by design (each
 * one owns its port). Nothing here can reach into the shell's DOM, and the
 * shell cannot reach into the app's.
 */
(function (global) {
  'use strict';

  const PROTOCOL = 1;
  const inFrame = global.parent !== global;

  const listeners = new Map();
  const pending = new Map();
  let seq = 0;
  let handshake = null;

  const state = {
    connected: false,
    theme: 'night',
    app: null,
    /* Vehicle telemetry. Until a real vehicle interface is wired up, the shell
     * reports `source: "simulated"` here — check it before you trust a number
     * on a screen a driver is looking at. */
    vehicle: { speed: null, unit: 'mph', gear: null, parked: true, source: 'unavailable' },
  };

  function emit(event, detail) {
    for (const fn of listeners.get(event) || []) {
      try { fn(detail); } catch (err) { console.error(`[headunit] ${event} handler threw`, err); }
    }
  }

  function post(type, payload, expectReply) {
    if (!inFrame) return Promise.resolve(null);
    const id = ++seq;
    global.parent.postMessage({ channel: 'headunit', protocol: PROTOCOL, id, type, payload }, '*');
    if (!expectReply) return Promise.resolve(null);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, 4000);
    });
  }

  global.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.channel !== 'headunit') return;

    if (msg.replyTo && pending.has(msg.replyTo)) {
      pending.get(msg.replyTo)(msg.payload);
      pending.delete(msg.replyTo);
      return;
    }

    switch (msg.type) {
      case 'welcome':
        state.connected = true;
        state.app = msg.payload.app;
        applyTheme(msg.payload.theme);
        if (msg.payload.vehicle) state.vehicle = msg.payload.vehicle;
        handshake?.(headunit);
        emit('connect', headunit);
        break;
      case 'theme':
        applyTheme(msg.payload.theme);
        break;
      case 'vehicle':
        state.vehicle = msg.payload;
        emit('vehicle', state.vehicle);
        break;
      case 'visibility':
        emit(msg.payload.visible ? 'foreground' : 'background', null);
        break;
    }
  });

  function applyTheme(theme) {
    if (!theme || theme === state.theme) {
      document.documentElement.setAttribute('data-theme', state.theme);
      return;
    }
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    emit('theme', theme);
  }

  const headunit = {
    get connected() { return state.connected; },
    get theme() { return state.theme; },
    get vehicle() { return state.vehicle; },
    get app() { return state.app; },

    /** Run `fn` once the shell has answered — or immediately when standalone. */
    ready(fn) {
      if (state.connected || !inFrame) fn(headunit);
      else handshake = fn;
      return headunit;
    },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },

    /** Name shown in the shell's status bar while this app is open. */
    setTitle(title) { return post('setTitle', { title }); },

    /** Hide the nav rail and take the full screen. Call with false to give it back. */
    setImmersive(immersive = true) { return post('setImmersive', { immersive }); },

    /** Ask the shell to open another installed app. */
    open(appId) { return post('open', { appId }); },

    /** Return to the launcher. */
    home() { return post('home', {}); },

    /** A brief message in the shell's own chrome, so it survives an app redraw. */
    toast(message, tone = 'info') { return post('toast', { message, tone }); },

    /** The installed apps, for a page that wants to build its own launcher. */
    listApps() { return post('listApps', {}, true); },
  };

  // Announce ourselves. The shell replies with `welcome`.
  if (inFrame) post('hello', { protocol: PROTOCOL, href: location.href });
  else applyTheme(state.theme);

  global.headunit = headunit;
})(window);
