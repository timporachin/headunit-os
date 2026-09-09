/*
 * YouTube app.
 *
 * youtube.com itself cannot be framed — it serves X-Frame-Options: SAMEORIGIN
 * — so this is built on the official IFrame Player, which is the supported way
 * to embed. That draws the line around what this app can be: it plays videos,
 * keeps a library, and searches. It is not a window onto the YouTube site, and
 * there is no signed-in feed, subscriptions or history behind it.
 *
 * It works with no API key at all. Titles, authors and thumbnails come from the
 * player and from i.ytimg.com, neither of which needs one. A key buys search
 * and nothing else.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LIB_KEY = 'headunit.youtube.library';

  let player = null;
  let ready = false;         // the YouTube embed has been constructed at least once
  let readyTimer = null;
  let attemptId = 0;         // so a stale timer cannot fail a newer attempt

  /* How long to wait for the embed to come up before saying it did not.
   * Long enough for a slow connection, short enough not to look hung. */
  const READY_TIMEOUT_MS = 12_000;
  let current = null;        // { id, title, author }
  let library = [];

  /* localStorage is per-origin and can throw outright in a locked-down browser,
   * so every touch of it is guarded and the app works with none of it. */
  const store = {
    read(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* nothing to do */ }
    },
    drop(key) {
      try { localStorage.removeItem(key); } catch { /* nothing to do */ }
    },
  };

  /* ── Video ids ──────────────────────────────────────────── */

  /**
   * Pull an 11-character video id out of whatever the user pasted: a watch
   * URL, a youtu.be short link, an embed or shorts URL, or a bare id. Returns
   * null when there is nothing that looks like an id, so callers can say so
   * rather than loading a blank player.
   */
  function parseVideoId(input) {
    const text = String(input || '').trim();
    if (!text) return null;

    const ID = /^[A-Za-z0-9_-]{11}$/;
    if (ID.test(text)) return text;

    let url;
    try {
      url = new URL(text.includes('://') ? text : `https://${text}`);
    } catch { return null; }

    const host = url.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return ID.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = url.searchParams.get('v');
      if (v && ID.test(v)) return v;
      const parts = url.pathname.split('/').filter(Boolean);
      const marker = parts.findIndex((p) => p === 'embed' || p === 'shorts' || p === 'live' || p === 'v');
      if (marker !== -1 && parts[marker + 1] && ID.test(parts[marker + 1])) return parts[marker + 1];
    }
    return null;
  }

  // Through this app's own server, matching what search results already return.
  const thumbFor = (id) => `/api/thumb?u=${encodeURIComponent(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`)}`;

  /* ── Player ─────────────────────────────────────────────── */

  /**
   * Create the Plyr instance on first use.
   *
   * Plyr drives the official YouTube IFrame API underneath, so playback is the
   * same supported embed as before — only the controls change, from YouTube's
   * small unstyleable set to real DOM we can size for a thumb and theme with
   * the OS tokens. It is built lazily because constructing a player with no
   * source is the fragile path, and nothing needs it until something plays.
   */
  function ensurePlayer() {
    if (player) return player;
    player = new Plyr('#player', {
      controls: ['restart', 'rewind', 'play', 'fast-forward', 'progress',
                 'current-time', 'duration', 'mute', 'volume', 'settings', 'fullscreen'],
      seekTime: 10,
      settings: ['quality', 'speed'],
      youtube: { rel: 0, modestbranding: 1, playsinline: 1 },
      storage: { enabled: true, key: 'headunit.youtube.plyr' },
    });
    const arrived = () => {
      ready = true;
      clearTimeout(readyTimer);
      clearUnavailable();
      readMeta();
    };
    player.on('ready', arrived);
    player.on('playing', arrived);
    player.on('error', onPlayerError);
    return player;
  }

  /**
   * Read what is actually playing from the underlying YouTube player.
   *
   * getVideoData is the reason this app needs no API key for titles. Plyr keeps
   * the YT.Player it created on `.embed`, so the data is still reachable.
   */
  function readMeta() {
    const embed = player && player.embed;
    const data = embed && embed.getVideoData ? embed.getVideoData() : null;
    if (!data || !data.video_id) return;
    current = { id: data.video_id, title: data.title || data.video_id, author: data.author || '' };
    $('nowTitle').textContent = current.title;
    $('nowBy').textContent = current.author;
    if (window.headunit) headunit.setTitle(`YouTube \u00b7 ${current.title}`);
    markCurrentRow();
    refreshSaveButton();
  }

  /*
   * Reporting an unreachable player is a statement about the last attempt, not a
   * permanent verdict. It used to latch: one failure disabled playback for the
   * whole session, which is precisely wrong in a vehicle that drives in and out
   * of coverage. Every attempt now starts clean and a success clears it.
   */
  function markUnavailable() {
    const box = $('placeholder');
    box.hidden = false;
    box.querySelector('.placeholder-mark').textContent = '\u26a0';
    box.querySelector('.placeholder-lede').textContent = 'YouTube is unreachable';
    box.querySelector('.placeholder-note').textContent =
      'The player could not be loaded. Check the connection and try again; your saved '
      + 'library is still here.';
    if (window.headunit) headunit.toast('Could not reach YouTube', 'warn');
  }

  function clearUnavailable() {
    const box = $('placeholder');
    box.hidden = true;
    box.querySelector('.placeholder-mark').textContent = '\u25b6';
    box.querySelector('.placeholder-lede').textContent = 'Nothing playing';
    box.querySelector('.placeholder-note').textContent =
      'Paste a link, or pick something from your library.';
  }

  /**
   * Always attempt. The player working is the only real evidence that the player
   * works — a probe of some other URL is a guess, and a bare cross-origin fetch
   * and an embedded iframe are different request types that browsers, blockers
   * and filters treat differently. Guessing from one about the other reported a
   * perfectly good player as unreachable.
   */
  function play(id) {
    if (!id) return;
    const attempt = ++attemptId;
    clearUnavailable();
    ensurePlayer();
    player.source = { type: 'video', sources: [{ src: id, provider: 'youtube' }] };
    player.play();

    // Only worth waiting on before the embed has ever come up; afterwards Plyr
    // is reused and readiness is not in question. The attempt check stops a
    // timer from an abandoned video failing the one that replaced it.
    clearTimeout(readyTimer);
    if (!ready) {
      readyTimer = setTimeout(() => {
        if (attempt === attemptId && !ready) markUnavailable();
      }, READY_TIMEOUT_MS);
    }
    // The title is not known the instant a source is set; Plyr's playing event
    // covers the normal case and this covers a video that never autoplays.
    setTimeout(readMeta, 1800);
  }

  function onPlayerError() {
    $('nowTitle').textContent = 'That video would not play';
    $('nowBy').textContent = 'It may be private, removed, or blocked from embedding.';
  }

  /* ── Library ────────────────────────────────────────────── */

  function loadLibrary() {
    const raw = store.read(LIB_KEY, []);
    library = Array.isArray(raw) ? raw.filter((e) => e && parseVideoId(e.id)) : [];
  }

  function saveLibrary() { store.write(LIB_KEY, library); }

  function inLibrary(id) { return library.some((e) => e.id === id); }

  function toggleSave() {
    if (!current) return;
    if (inLibrary(current.id)) {
      library = library.filter((e) => e.id !== current.id);
      if (window.headunit) headunit.toast('Removed from library');
    } else {
      library.unshift({ id: current.id, title: current.title, author: current.author });
      if (window.headunit) headunit.toast('Saved to library');
    }
    saveLibrary();
    renderLibrary();
    refreshSaveButton();
  }

  function refreshSaveButton() {
    const saved = current && inLibrary(current.id);
    $('saveBtn').textContent = saved ? '★' : '☆';
    $('saveBtn').setAttribute('aria-pressed', String(Boolean(saved)));
  }

  /** One list row. Used by both the library and search results. */
  function rowFor(entry, { removable }) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = entry.id;

    const hit = document.createElement('button');
    hit.className = 'row-hit';
    // Server-supplied thumbnails are better sized than the i.ytimg guess, but
    // the guess still covers a library entry saved before thumbs were stored.
    const meta = [entry.author, entry.duration, entry.views].filter(Boolean).join(' · ');
    hit.innerHTML = `
      <img class="row-thumb" alt="" loading="lazy" src="${escape(entry.thumb || thumbFor(entry.id))}">
      <span class="row-text">
        <span class="row-title">${escape(entry.title)}</span>
        <span class="row-by">${escape(meta)}</span>
      </span>`;
    hit.addEventListener('click', () => play(entry.id));
    li.append(hit);

    if (removable) {
      const drop = document.createElement('button');
      drop.className = 'row-drop';
      drop.textContent = '✕';
      drop.title = `Remove ${entry.title}`;
      drop.setAttribute('aria-label', `Remove ${entry.title}`);
      drop.addEventListener('click', (event) => {
        event.stopPropagation();
        library = library.filter((e) => e.id !== entry.id);
        saveLibrary();
        renderLibrary();
        refreshSaveButton();
      });
      li.append(drop);
    }
    return li;
  }

  function renderLibrary() {
    const list = $('libraryList');
    list.replaceChildren(...library.map((e) => rowFor(e, { removable: true })));
    $('libraryEmpty').hidden = library.length > 0;
    markCurrentRow();
  }

  function markCurrentRow() {
    for (const li of document.querySelectorAll('.row')) {
      if (current && li.dataset.id === current.id) li.setAttribute('aria-current', 'true');
      else li.removeAttribute('aria-current');
    }
  }

  /* ── Search ─────────────────────────────────────────────── */

  /*
   * Search runs against this app's own server, which talks to InnerTube. No key,
   * no quota, and no dead search box waiting for one — the reason the old key
   * panel is gone.
   */
  let suggestTimer = null;

  async function runSearch(term) {
    const q = (term ?? $('searchInput').value).trim();
    if (!q) return;
    $('searchInput').value = q;
    hideSuggestions();

    const note = $('searchEmpty');
    note.hidden = false;
    note.textContent = 'Searching…';
    $('resultsList').replaceChildren();

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      if (!res.ok) {
        note.textContent = body.error || `Search failed (${res.status})`;
        return;
      }
      const items = body.videos || [];
      $('resultsList').replaceChildren(...items.map((e) => rowFor(e, { removable: false })));
      note.hidden = items.length > 0;
      note.textContent = items.length ? '' : 'Nothing matched that.';
    } catch (err) {
      note.textContent = `Could not reach the search service: ${err.message}`;
    }
  }

  function hideSuggestions() {
    $('suggestions').hidden = true;
    $('suggestions').replaceChildren();
  }

  /** Offer somewhere to stop typing — the worst part of any touchscreen. */
  async function refreshSuggestions() {
    const q = $('searchInput').value.trim();
    if (q.length < 2) return hideSuggestions();
    try {
      const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
      const { suggestions = [] } = await res.json();
      if (!suggestions.length) return hideSuggestions();
      const box = $('suggestions');
      box.replaceChildren(...suggestions.map((text) => {
        const chip = document.createElement('button');
        chip.className = 'suggest';
        chip.textContent = text;
        chip.addEventListener('click', () => runSearch(text));
        return chip;
      }));
      box.hidden = false;
    } catch {
      hideSuggestions();
    }
  }

  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ── Drive lock ─────────────────────────────────────────── */

  /**
   * Hide the picture while the vehicle is moving, leaving the audio running.
   *
   * This deliberately does nothing until a real vehicle signal exists: with
   * `source: "unavailable"` the shell is telling us it does not know, and
   * treating "don't know" as "parked" would be inventing permission. It is
   * wired now so that the day telemetry arrives, the behaviour is already here.
   */
  function applyDriveLock(vehicle) {
    const known = vehicle && vehicle.source && vehicle.source !== 'unavailable';
    const moving = known && vehicle.parked === false;
    $('drivelock').hidden = !moving;
  }

  /* ── Wiring ─────────────────────────────────────────────── */

  function showTab(which) {
    const lib = which === 'library';
    $('tabLibrary').setAttribute('aria-selected', String(lib));
    $('tabSearch').setAttribute('aria-selected', String(!lib));
    $('paneLibrary').hidden = !lib;
    $('paneSearch').hidden = lib;
  }

  $('tabLibrary').addEventListener('click', () => showTab('library'));
  $('tabSearch').addEventListener('click', () => showTab('search'));

  $('urlBtn').addEventListener('click', submitUrl);
  $('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitUrl(); });

  function submitUrl() {
    const id = parseVideoId($('urlInput').value);
    if (!id) {
      if (window.headunit) headunit.toast('That is not a YouTube link or video id', 'warn');
      return;
    }
    $('urlInput').value = '';
    play(id);
  }

  // Play, seek, volume, quality and fullscreen are Plyr's now. What stays here
  // is the two things Plyr has no opinion about.
  $('saveBtn').addEventListener('click', toggleSave);

  let immersive = false;
  $('fullBtn').addEventListener('click', () => {
    immersive = !immersive;
    $('fullBtn').setAttribute('aria-pressed', String(immersive));
    if (window.headunit) headunit.setImmersive(immersive);
  });

  $('searchBtn').addEventListener('click', () => runSearch());
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  $('searchInput').addEventListener('input', () => {
    // Debounced: a suggestion request per keystroke is a request per keystroke.
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(refreshSuggestions, 220);
  });

  /* ── Go ─────────────────────────────────────────────────── */

  loadLibrary();
  renderLibrary();
  refreshSaveButton();
  showTab('library');

  if (window.headunit) {
    headunit.ready((hu) => {
      hu.setTitle('YouTube');
      applyDriveLock(hu.vehicle);
    });
    headunit.on('vehicle', applyDriveLock);
    // Audio deliberately keeps running when the user switches to another app —
    // that is the point of a head unit, not an oversight.
  }

  // Exposed so the behaviour of the id parser can be tested without a browser.
  window.__youtubeApp = { parseVideoId };
})();
