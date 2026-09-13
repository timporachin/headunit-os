/*
 * Family.
 *
 * Reads this app's own server, never a location service directly — the browser
 * could not do that anyway, since Life360 sends no CORS headers at all. Every
 * member arrives already normalised, so nothing here knows or cares which
 * source it came from.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    fam: $('fam'), synthetic: $('synthetic'),
    side: $('side'), circle: $('circle'), refresh: $('refresh'), people: $('people'),
    map: $('map'), fitAll: $('fitAll'), status: $('status'),
    setup: $('setup'), tabs: $('tabs'), loginForm: $('loginForm'),
    username: $('username'), password: $('password'), token: $('token'),
    signIn: $('signIn'), setupProblem: $('setupProblem'), useDemo: $('useDemo'),
  };

  const POLL_MS = 60_000;
  const MINUTE = 60_000;

  const state = {
    data: null,
    selectedId: null,
    mode: 'password',
    units: { speed: 'mph', temp: 'F' },
    home: null,
    polling: false,
  };

  let map = null;
  let markers = new Map();
  let timer = null;

  /* ── Small helpers ────────────────────────────────────────── */
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const initials = (name) => String(name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  /* A stable colour per person, so the pin on the map and the row in the list
   * are obviously the same human.
   *
   * Spread by the golden angle rather than straight modulo 360. Ids in a circle
   * usually differ by a character or two, and taking the hash mod 360 put every
   * one of them within a few degrees of the others — four pins, four greens,
   * and no way to tell whose was whose. */
  function tint(id) {
    let hash = 0;
    for (const ch of String(id)) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
    return `hsl(${Math.abs(hash) * 137.508 % 360} 70% 62%)`;
  }

  function ago(ms) {
    if (ms === null || ms === undefined) return 'never reported';
    const mins = Math.round((Date.now() - ms) / MINUTE);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
  }

  const usesMiles = () => state.units.speed !== 'km/h';

  /** Straight-line distance. Labelled as such: this is not a driving distance. */
  function distanceFrom(home, lat, lon) {
    if (!home || lat === null || lon === null) return null;
    const R = 6371;
    const rad = Math.PI / 180;
    const dLat = (lat - home.lat) * rad;
    const dLon = (lon - home.lon) * rad;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(home.lat * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(a));
    return usesMiles() ? { value: km / 1.609344, unit: 'mi' } : { value: km, unit: 'km' };
  }

  /* ── Talking to our own server ────────────────────────────── */
  async function api(path, body) {
    const res = await fetch(`/api/${path}`, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {});
    if (!res.ok && res.status !== 429) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function load() {
    try {
      state.data = await api('state');
      render();
    } catch (err) {
      el.status.dataset.tone = 'alert';
      el.status.textContent = `Could not reach the Family service: ${err.message}`;
    }
  }

  /* ── Rendering ────────────────────────────────────────────── */
  function renderStatus() {
    const d = state.data;
    if (!d) return;
    if (d.problem) {
      el.status.dataset.tone = d.backoffUntil ? 'warn' : 'alert';
      const wait = d.backoffUntil ? Math.max(0, Math.ceil((d.backoffUntil - Date.now()) / MINUTE)) : 0;
      el.status.textContent = wait
        ? `${d.problem} (about ${wait} min left)`
        : d.problem;
      return;
    }
    el.status.dataset.tone = 'info';
    const when = d.lastUpdate
      ? new Date(d.lastUpdate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';
    el.status.textContent = `${d.members.length} in this circle · updated ${when} · ${d.providerLabel}`;
  }

  function personRow(m) {
    const dist = distanceFrom(state.home, m.lat, m.lon);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'person';
    row.style.setProperty('--tint', tint(m.id));
    if (m.id === state.selectedId) row.setAttribute('aria-current', 'true');

    const badges = [
      m.isDriving ? '<span class="badge badge-driving">driving</span>' : '',
      m.stale ? '<span class="badge badge-stale">stale</span>' : '',
    ].join('');

    row.innerHTML = `
      <span class="avatar"></span>
      <span class="person-main">
        <span class="person-name"><span>${escape(m.name)}</span>${badges}</span>
        <p class="person-where">${m.lat === null ? 'No position reported' : escape(m.address || 'Somewhere unnamed')}</p>
        <p class="person-meta"></p>
      </span>`;

    const avatar = row.querySelector('.avatar');
    if (m.avatarUrl) {
      const img = document.createElement('img');
      img.alt = '';
      // If the picture will not load, the initials underneath are the answer.
      img.addEventListener('error', () => img.remove(), { once: true });
      img.src = m.avatarUrl;
      avatar.append(img);
    }
    avatar.insertAdjacentText('afterbegin', initials(m.name));

    /* Each of these can be null, and a null is drawn as a dash rather than
     * filled in with something plausible. Built as nodes so the low-battery
     * warning can carry its own class. */
    const meta = row.querySelector('.person-meta');
    const bits = [];
    bits.push(m.battery === null
      ? { text: 'battery —', low: false }
      : { text: `battery ${Math.round(m.battery)}%${m.charging ? ' charging' : ''}`,
          low: m.battery <= 20 && !m.charging });
    if (dist) bits.push({ text: `${dist.value.toFixed(1)} ${dist.unit} away, straight line`, low: false });
    bits.push({ text: ago(m.since), low: false });
    for (const bit of bits) {
      const span = document.createElement('span');
      if (bit.low) span.className = 'low';
      span.textContent = bit.text;
      meta.append(span);
    }

    row.addEventListener('click', () => select(m.id, { fly: true }));

    if (state.data.canRequestUpdate && m.lat !== null) {
      const ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'ghost person-actions';
      ask.textContent = 'Ping';
      ask.title = 'Ask this phone to report its position now';
      // This buzzes somebody's phone, so it is a deliberate tap and never a timer.
      ask.addEventListener('click', async (event) => {
        event.stopPropagation();
        ask.disabled = true;
        ask.textContent = 'Asked';
        const reply = await api('request', { memberId: m.id }).catch((e) => ({ error: e.message }));
        if (reply.error) {
          el.status.dataset.tone = 'warn';
          el.status.textContent = reply.error;
        }
        setTimeout(() => { ask.disabled = false; ask.textContent = 'Ping'; }, 5000);
      });
      row.append(ask);
    }
    return row;
  }

  function renderPeople() {
    const members = state.data?.members || [];
    el.people.replaceChildren();
    if (!members.length) {
      const empty = document.createElement('p');
      empty.className = 'people-empty';
      empty.textContent = 'Nobody in this circle is sharing a position right now.';
      el.people.append(empty);
      return;
    }
    for (const m of members) el.people.append(personRow(m));
  }

  function renderCircles() {
    const d = state.data;
    const many = (d?.circles || []).length > 1;
    el.circle.hidden = !many;
    if (!many) return;
    el.circle.replaceChildren();
    for (const c of d.circles) {
      const option = document.createElement('option');
      option.value = c.id;
      option.textContent = c.name;
      option.selected = c.id === d.circleId;
      el.circle.append(option);
    }
  }

  let framedOnce = false;

  function renderMap() {
    const members = (state.data?.members || []).filter((m) => m.lat !== null && m.lon !== null);
    if (!map && members.length) buildMap(members[0]);
    if (!map) return;

    const seen = new Set();
    for (const m of members) {
      seen.add(m.id);
      const icon = L.divIcon({
        className: '',
        html: `<div class="pin${m.stale ? ' is-stale' : ''}" style="--tint:${tint(m.id)}">${escape(initials(m.name))}</div>`,
        iconSize: [42, 42], iconAnchor: [21, 21],
      });
      if (markers.has(m.id)) {
        markers.get(m.id).setLatLng([m.lat, m.lon]).setIcon(icon);
      } else {
        const marker = L.marker([m.lat, m.lon], { icon, title: m.name })
          .addTo(map)
          .on('click', () => select(m.id, { fly: false }));
        markers.set(m.id, marker);
      }
    }
    for (const [id, marker] of markers) {
      if (!seen.has(id)) { marker.remove(); markers.delete(id); }
    }
    el.fitAll.hidden = members.length < 2;

    // Open on everyone rather than on whoever happened to be first in the list;
    // a family map whose default view hides half the family is the wrong default.
    if (!framedOnce && members.length > 1) {
      framedOnce = true;
      fitEveryone();
    }
  }

  function fitEveryone() {
    const points = (state.data?.members || [])
      .filter((m) => m.lat !== null && m.lon !== null).map((m) => [m.lat, m.lon]);
    if (map && points.length > 1) map.fitBounds(points, { padding: [70, 70], maxZoom: 15 });
    else if (map && points.length === 1) map.setView(points[0], 13);
  }

  function buildMap(first) {
    map = L.map(el.map, { zoomControl: false, attributionControl: true })
      .setView([first.lat, first.lon], 11);
    map.createPane('basemap').style.zIndex = '200';
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      pane: 'basemap', minZoom: 3, maxZoom: 17, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
  }

  function select(id, { fly }) {
    state.selectedId = id;
    const m = (state.data?.members || []).find((x) => x.id === id);
    if (fly && map && m && m.lat !== null) map.setView([m.lat, m.lon], Math.max(map.getZoom(), 14));
    renderPeople();
  }

  el.fitAll.addEventListener('click', fitEveryone);

  el.refresh.addEventListener('click', load);
  el.circle.addEventListener('change', async () => {
    state.data = await api('circle', { circleId: el.circle.value });
    render();
  });

  function render() {
    const d = state.data;
    if (!d) return;
    el.setup.hidden = d.authenticated;
    el.synthetic.hidden = !d.synthetic;
    renderCircles();
    renderPeople();
    renderMap();
    renderStatus();
    if (d.authenticated && !state.polling) startPolling();
    if (!d.authenticated && state.polling) stopPolling();
  }

  /* ── Setup ────────────────────────────────────────────────── */
  el.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('button[role="tab"]');
    if (!tab) return;
    state.mode = tab.dataset.mode;
    for (const b of el.tabs.querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b === tab));
    }
    for (const pane of el.setup.querySelectorAll('.pane')) {
      pane.hidden = pane.dataset.pane !== state.mode;
    }
  });

  async function signIn(payload) {
    el.signIn.disabled = true;
    el.setupProblem.hidden = true;
    try {
      state.data = await api('login', payload);
      if (!state.data.authenticated) {
        el.setupProblem.hidden = false;
        el.setupProblem.textContent = state.data.problem || 'That did not work.';
      }
      render();
    } catch (err) {
      el.setupProblem.hidden = false;
      el.setupProblem.textContent = err.message;
    } finally {
      el.signIn.disabled = false;
    }
  }

  el.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    signIn(state.mode === 'token'
      ? { provider: 'life360', mode: 'token', token: el.token.value.trim() }
      : { provider: 'life360', mode: 'password', username: el.username.value.trim(), password: el.password.value });
    // The password never stays in the DOM longer than the request needs it.
    el.password.value = '';
    el.token.value = '';
  });

  el.useDemo.addEventListener('click', () => signIn({ provider: 'demo', mode: 'password' }));

  /* ── Polling ──────────────────────────────────────────────── */
  /* The server enforces its own floor, so asking more often than this changes
   * nothing upstream — but a head unit in a canyon should not be asking at all
   * while nobody is looking at it. */
  function startPolling() {
    stopPolling();
    state.polling = true;
    timer = setInterval(load, POLL_MS);
  }

  function stopPolling() {
    state.polling = false;
    clearInterval(timer);
    timer = null;
  }

  headunit.on('background', stopPolling);
  headunit.on('foreground', () => { if (state.data?.authenticated) { startPolling(); load(); } });
  headunit.on('settings', (next) => {
    if (next?.units) state.units = next.units;
    state.home = next?.location || state.home;
    renderPeople();
  });

  headunit.ready((hu) => {
    if (hu.settings?.units) state.units = hu.settings.units;
    state.home = hu.settings?.location || null;
    load();
  });
})();
