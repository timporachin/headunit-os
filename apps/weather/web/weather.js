/*
 * Weather and radar.
 *
 * Two public sources, neither of which needs a key or an account:
 *
 *   api.weather.gov   conditions, forecast and active alerts. US only.
 *   api.rainviewer.com  a two-hour radar loop, worldwide.
 *
 * Both send access-control-allow-origin: *, so the page talks to them directly
 * and the shell proxies nothing. Everything drawn here is measured or forecast
 * by somebody who signs their name to it; where a field is missing it says so
 * with a dash rather than filling the gap.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    alerts: $('alerts'), side: $('side'), now: $('now'),
    hourlyBlock: $('hourlyBlock'), hours: $('hours'),
    dailyBlock: $('dailyBlock'), days: $('days'),
    map: $('map'), radarBar: $('radarBar'), playBtn: $('playBtn'),
    scrub: $('scrub'), frameTime: $('frameTime'), recenter: $('recenter'),
    status: $('status'),
    locate: $('locate'), locGps: $('locGps'), locLat: $('locLat'),
    locLon: $('locLon'), locSave: $('locSave'), locHint: $('locHint'),
  };

  const NWS = 'https://api.weather.gov';
  const RAINVIEWER = 'https://api.rainviewer.com/public/weather-maps.json';
  const STORE_KEY = 'headunit.weather.location';
  const RADAR_OPACITY = 0.72;
  const FRAME_MS = 500;          // how long each radar frame is held
  const LOOP_PAUSE_MS = 1400;    // a beat on the newest frame before looping
  const REFRESH = { obs: 5 * 60_000, forecast: 10 * 60_000, alerts: 5 * 60_000, radar: 5 * 60_000 };

  const state = {
    location: null,
    place: '',
    point: null,         // the cached /points response for this location
    inUS: true,
    units: { speed: 'mph', temp: 'F' },
    obs: null,
    station: '',
    hourly: [],
    daily: [],
    alerts: [],
    frames: [],          // [{ time, path, forecast }]
    layers: [],
    index: 0,
    playing: true,
    lastUpdate: null,
    problem: '',
    radarProblem: '',
  };

  /* ── Units ────────────────────────────────────────────────
   * Every NWS observation carries the unit it was measured in, and it is not
   * the same unit for every field, so convert from what is declared rather
   * than from what a US endpoint is assumed to return. */
  const cToF = (c) => (c * 9) / 5 + 32;
  const fToC = (f) => ((f - 32) * 5) / 9;

  function temperature(measure) {
    if (!measure || measure.value === null || measure.value === undefined) return null;
    const c = /degC/.test(measure.unitCode) ? measure.value : fToC(measure.value);
    return state.units.temp === 'C' ? c : cToF(c);
  }

  function windSpeed(measure) {
    if (!measure || measure.value === null || measure.value === undefined) return null;
    let kmh = measure.value;
    if (/m_s-1/.test(measure.unitCode)) kmh = measure.value * 3.6;
    return state.units.speed === 'km/h' ? kmh : kmh / 1.609344;
  }

  /** A forecast period's temperature, which NWS gives in F on the US endpoints. */
  function periodTemp(period) {
    if (period?.temperature === null || period?.temperature === undefined) return null;
    const f = period.temperatureUnit === 'C' ? cToF(period.temperature) : period.temperature;
    return state.units.temp === 'C' ? fToC(f) : f;
  }

  const tempUnit = () => (state.units.temp === 'C' ? '°C' : '°F');
  const round = (n) => (n === null ? null : Math.round(n));
  const show = (n, suffix = '') => (n === null || n === undefined ? '—' : `${n}${suffix}`);
  const pct = (measure) => (measure && measure.value !== null ? measure.value : null);

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (deg) => (deg === null || deg === undefined ? '' : COMPASS[Math.round(deg / 22.5) % 16]);

  const clockOf = (value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /* ── Weather glyphs ───────────────────────────────────────
   * Drawn here rather than pulled from api.weather.gov/icons: the icon
   * endpoint is deprecated upstream, and a head unit that has just lost signal
   * should still render the last forecast it has instead of a row of broken
   * images. Matched off shortForecast, which is the field NWS actually keeps. */
  const G = {
    sun: '<circle cx="12" cy="12" r="4.6"/><path d="M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7"/>',
    moon: '<path d="M20 14.2A8.4 8.4 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/>',
    cloud: '<path d="M17.5 18H7a4.2 4.2 0 0 1-.6-8.4 5.6 5.6 0 0 1 10.8 1.5A3.5 3.5 0 0 1 17.5 18z"/>',
    partsun: '<circle cx="8.4" cy="8" r="3.1"/><path d="M8.4 1.9v1.6M2.3 8h1.6M4.1 3.7l1.1 1.1M12.7 3.7l-1.1 1.1"/><path d="M18.4 19.5h-7.9a3.6 3.6 0 0 1-.5-7.2 4.8 4.8 0 0 1 9.2 1.3 3 3 0 0 1-.8 5.9z"/>',
    partmoon: '<path d="M14.6 9.3A5.6 5.6 0 0 1 8 2.7a5.6 5.6 0 1 0 6.6 6.6z"/><path d="M18.4 19.5h-7.9a3.6 3.6 0 0 1-.5-7.2 4.8 4.8 0 0 1 9.2 1.3 3 3 0 0 1-.8 5.9z"/>',
    rain: '<path d="M17.5 15.4H7a4.2 4.2 0 0 1-.6-8.4 5.6 5.6 0 0 1 10.8 1.5 3.5 3.5 0 0 1 .3 6.9z"/><path d="M8.6 18.4l-.9 2.6M12.4 18.4l-.9 2.6M16.2 18.4l-.9 2.6"/>',
    snow: '<path d="M17.5 14.6H7a4.2 4.2 0 0 1-.6-8.4 5.6 5.6 0 0 1 10.8 1.5 3.5 3.5 0 0 1 .3 6.9z"/><path d="M8.4 18.2v2.6M7.1 19.5h2.6M15.6 18.2v2.6M14.3 19.5h2.6M12 17.6v2.6"/>',
    thunder: '<path d="M17.5 13.6H7A4.2 4.2 0 0 1 6.4 5.2 5.6 5.6 0 0 1 17.2 6.7a3.5 3.5 0 0 1 .3 6.9z"/><path d="M13 15.4l-3.2 4.2h2.6l-1 3.2"/>',
    fog: '<path d="M17.2 11.4H7.4a4 4 0 0 1-.6-8 5.4 5.4 0 0 1 10.4 1.5"/><path d="M3.6 15h16.8M5.8 18.4h13.2M8 21.6h8.6"/>',
    wind: '<path d="M3.5 8.6h10a2.8 2.8 0 1 0-2.8-2.8"/><path d="M3.5 13.4h13.8a2.8 2.8 0 1 1-2.8 2.8"/><path d="M3.5 18.2h7.2"/>',
  };

  function glyphKey(text, daytime) {
    const t = String(text || '').toLowerCase();
    if (/thunder|t-storm/.test(t)) return 'thunder';
    if (/snow|sleet|ice|freezing|blizzard|flurr|wintry/.test(t)) return 'snow';
    if (/rain|shower|drizzle/.test(t)) return 'rain';
    if (/fog|haze|smoke|mist/.test(t)) return 'fog';
    if (/overcast/.test(t)) return 'cloud';
    if (/partly|mostly (sunny|clear)|few clouds|scattered clouds/.test(t)) {
      return daytime ? 'partsun' : 'partmoon';
    }
    if (/cloud/.test(t)) return 'cloud';
    if (/clear|sunny|fair|hot/.test(t)) return daytime ? 'sun' : 'moon';
    if (/wind|breez|blustery/.test(t)) return 'wind';
    return daytime ? 'sun' : 'moon';
  }

  const glyph = (text, daytime) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"`
    + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${G[glyphKey(text, daytime)]}</svg>`;

  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ── Fetching ─────────────────────────────────────────────── */
  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function setStatus() {
    const troubles = [state.problem, state.radarProblem].filter(Boolean);
    if (troubles.length) {
      el.status.dataset.tone = 'alert';
      el.status.textContent = troubles.join(' · ');
      return;
    }
    el.status.dataset.tone = 'info';
    const when = state.lastUpdate ? clockOf(state.lastUpdate) : '—';
    const sources = state.inUS ? 'National Weather Service and RainViewer' : 'RainViewer';
    el.status.textContent = `Updated ${when} · ${sources}`;
  }

  /* ── Rendering ────────────────────────────────────────────── */
  function renderNow() {
    if (!state.inUS) {
      el.now.innerHTML = '<p class="placeholder">The National Weather Service only covers the United States,'
        + ' so there is no forecast for this position. The radar beside it is worldwide.</p>';
      return;
    }
    if (!state.obs && !state.hourly.length) {
      el.now.innerHTML = '<p class="placeholder">No conditions yet.</p>';
      return;
    }

    const props = state.obs || {};
    const nowHour = state.hourly[0] || null;
    /* Stations often report a temperature and an empty textDescription. The
     * measurement stays the station's; the words come from the forecast for
     * this hour, which is the closest honest substitute. */
    const described = props.textDescription || nowHour?.shortForecast || '';
    const daytime = nowHour ? nowHour.isDaytime : true;

    const t = round(temperature(props.temperature)) ?? round(periodTemp(nowHour));
    const feels = round(temperature(props.heatIndex)) ?? round(temperature(props.windChill));
    const wind = round(windSpeed(props.windSpeed));
    const gust = round(windSpeed(props.windGust));
    const dir = compass(props.windDirection?.value);
    const humidity = round(pct(props.relativeHumidity) ?? pct(nowHour?.relativeHumidity));
    const visM = props.visibility?.value ?? null;
    const visibility = visM === null ? null
      : state.units.speed === 'km/h' ? `${(visM / 1000).toFixed(1)} km` : `${(visM / 1609.344).toFixed(1)} mi`;

    el.now.innerHTML = `
      <div class="now-main">
        <span class="now-glyph">${glyph(described, daytime)}</span>
        <div>
          <div class="now-temp">${show(t)}<span>${tempUnit()}</span></div>
          <div class="now-desc">${escape(described || 'No description reported')}</div>
        </div>
      </div>
      <p class="now-place">${escape(state.place || 'Unknown place')}${state.station ? ` · station ${escape(state.station)}` : ''}</p>
      <dl class="now-stats">
        <div><dt>Feels like</dt><dd>${feels === null ? '—' : `${feels}${tempUnit()}`}</dd></div>
        <div><dt>Wind</dt><dd>${wind === null ? '—' : wind === 0 ? 'Calm' : `${dir} ${wind} ${state.units.speed}`}</dd></div>
        <div><dt>Gusting</dt><dd>${gust === null ? '—' : `${gust} ${state.units.speed}`}</dd></div>
        <div><dt>Humidity</dt><dd>${show(humidity, '%')}</dd></div>
        <div><dt>Visibility</dt><dd>${show(visibility)}</dd></div>
        <div><dt>Rain chance</dt><dd>${show(pct(nowHour?.probabilityOfPrecipitation), '%')}</dd></div>
      </dl>`;
  }

  function renderHours() {
    const periods = state.hourly.slice(0, 12);
    el.hourlyBlock.hidden = periods.length === 0;
    el.hours.innerHTML = periods.map((p) => {
      const chance = pct(p.probabilityOfPrecipitation);
      return `<div class="hour">
        <div class="h-time">${clockOf(p.startTime)}</div>
        <div class="h-glyph">${glyph(p.shortForecast, p.isDaytime)}</div>
        <div class="h-temp">${show(round(periodTemp(p)), '°')}</div>
        <div class="h-pop">${chance ? `${chance}%` : ''}</div>
      </div>`;
    }).join('');
  }

  /* NWS periods alternate day and night. Pair them so a row is a day with a
   * high and a low, rather than fourteen half-rows. */
  function buildDays(periods) {
    const days = [];
    for (let i = 0; i < periods.length && days.length < 7; i += 1) {
      const p = periods[i];
      const next = periods[i + 1];
      if (p.isDaytime && next && !next.isDaytime) {
        days.push({ name: p.name, high: p, low: next, text: p.shortForecast, daytime: true });
        i += 1;
      } else {
        days.push({ name: p.name, high: p.isDaytime ? p : null, low: p.isDaytime ? null : p,
                    text: p.shortForecast, daytime: p.isDaytime });
      }
    }
    return days;
  }

  function renderDays() {
    el.dailyBlock.hidden = state.daily.length === 0;
    el.days.innerHTML = state.daily.map((d) => {
      const chance = pct((d.high || d.low)?.probabilityOfPrecipitation);
      const hi = round(periodTemp(d.high));
      const lo = round(periodTemp(d.low));
      return `<div class="day">
        <span class="d-name" title="${escape(d.text)}">${escape(d.name)}</span>
        <span class="d-glyph">${glyph(d.text, d.daytime)}</span>
        <span class="d-pop">${chance ? `${chance}%` : ''}</span>
        <span class="d-temps">${show(hi, '°')} <span class="lo">${show(lo, '°')}</span></span>
      </div>`;
    }).join('');
  }

  function renderAlerts() {
    el.alerts.hidden = state.alerts.length === 0;
    el.alerts.replaceChildren();
    for (const feature of state.alerts) {
      const a = feature.properties;
      const node = document.createElement('div');
      node.className = 'alert';
      node.dataset.severity = a.severity || 'Unknown';
      node.innerHTML = `
        <div class="alert-head">
          <span class="alert-event">${escape(a.event)}</span>
          <span class="alert-when">until ${escape(new Date(a.ends || a.expires).toLocaleString([], {
            weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
        </div>
        <p class="alert-headline">${escape(a.headline || '')}</p>`;
      const detail = document.createElement('p');
      detail.className = 'alert-detail';
      detail.hidden = true;
      detail.textContent = [a.description, a.instruction].filter(Boolean).join('\n\n');
      node.append(detail);
      node.addEventListener('click', () => {
        node.classList.toggle('open');
        detail.hidden = !node.classList.contains('open');
      });
      el.alerts.append(node);
    }
  }

  function renderAll() {
    renderNow();
    renderHours();
    renderDays();
    renderAlerts();
    setStatus();
  }

  /* ── The map ──────────────────────────────────────────────── */
  let map = null;
  let marker = null;

  function buildMap(lat, lon) {
    map = L.map(el.map, { zoomControl: false, attributionControl: true }).setView([lat, lon], 8);

    // Separate panes so the night filter can darken the cartography without
    // also inverting the rain painted on top of it.
    map.createPane('basemap').style.zIndex = '200';
    map.createPane('radar').style.zIndex = '300';

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      pane: 'basemap', minZoom: 3, maxZoom: 12,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    // Top right, not bottom: the radar bar owns the bottom edge, and at 48px a
    // side the zoom buttons sat right on top of the recenter control.
    L.control.zoom({ position: 'topright' }).addTo(map);
    marker = L.circleMarker([lat, lon], {
      radius: 7, weight: 3, color: '#ffffff', fillColor: '#4a9eff', fillOpacity: 1,
    }).addTo(map);
  }

  function moveMap(lat, lon) {
    if (!map) return buildMap(lat, lon);
    marker.setLatLng([lat, lon]);
    map.setView([lat, lon], map.getZoom());
  }

  /* ── Radar ────────────────────────────────────────────────── */
  let animTimer = null;

  async function refreshRadar() {
    let data;
    try {
      data = await getJSON(RAINVIEWER);
    } catch (err) {
      note(`Radar unavailable: ${err.message}`);
      return;
    }

    const past = (data.radar?.past || []).map((f) => ({ ...f, forecast: false }));
    const soon = (data.radar?.nowcast || []).map((f) => ({ ...f, forecast: true }));
    const frames = [...past, ...soon];
    if (!frames.length) { note('Radar returned no frames.'); return; }

    for (const layer of state.layers) layer.remove();
    state.layers = frames.map((frame) => L.tileLayer(
      `${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
      { pane: 'radar', opacity: 0, minZoom: 3, maxZoom: 12, tileSize: 256 },
    ).addTo(map));

    state.radarProblem = '';
    state.frames = frames;
    el.scrub.max = String(frames.length - 1);
    el.radarBar.hidden = false;
    // Land on the most recent observed frame, not on a nowcast.
    showFrame(Math.max(0, past.length - 1));
    if (state.playing) play();
  }

  function showFrame(i) {
    if (!state.frames.length) return;
    const count = state.frames.length;
    state.index = ((i % count) + count) % count;
    state.layers.forEach((layer, k) => layer.setOpacity(k === state.index ? RADAR_OPACITY : 0));
    const frame = state.frames[state.index];
    el.scrub.value = String(state.index);
    el.frameTime.textContent = clockOf(frame.time * 1000);
    el.frameTime.dataset.forecast = String(frame.forecast);
  }

  function play() {
    stop();
    state.playing = true;
    el.playBtn.setAttribute('aria-label', 'Pause radar');
    el.playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/></svg>';
    const step = () => {
      showFrame(state.index + 1);
      // Hold on the newest frame: it is the one anybody is actually reading.
      const newest = state.index === state.frames.length - 1;
      animTimer = setTimeout(step, newest ? LOOP_PAUSE_MS : FRAME_MS);
    };
    animTimer = setTimeout(step, FRAME_MS);
  }

  function stop() {
    clearTimeout(animTimer);
    animTimer = null;
  }

  function pause() {
    stop();
    state.playing = false;
    el.playBtn.setAttribute('aria-label', 'Play radar');
    el.playBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>';
  }

  el.playBtn.addEventListener('click', () => (state.playing ? pause() : play()));
  el.scrub.addEventListener('input', () => { pause(); showFrame(Number(el.scrub.value)); });
  el.recenter.addEventListener('click', () => {
    if (state.location) map.setView([state.location.lat, state.location.lon], 8);
  });

  /* ── Loading the weather ──────────────────────────────────── */
  function note(message) {
    state.radarProblem = message;
    setStatus();
  }

  /** The nearest station is not always the one reporting: it can be live and
   *  sending nulls. Walk the first few and take the first with a temperature. */
  async function loadObservation(stationsUrl) {
    const list = await getJSON(stationsUrl);
    for (const url of (list.observationStations || []).slice(0, 4)) {
      try {
        const latest = await getJSON(`${url}/observations/latest`);
        if (latest?.properties?.temperature?.value !== null
            && latest?.properties?.temperature?.value !== undefined) {
          return { props: latest.properties, station: url.split('/').pop() };
        }
      } catch { /* try the next station along */ }
    }
    return null;
  }

  async function loadPoint(lat, lon) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    try {
      state.point = await getJSON(`${NWS}/points/${key}`);
      state.inUS = true;
      const rl = state.point.properties.relativeLocation?.properties;
      state.place = rl ? `${rl.city}, ${rl.state}` : '';
    } catch (err) {
      // 404 from /points is how NWS says "outside our coverage", not a fault.
      if (err.status === 404) {
        state.inUS = false;
        state.point = null;
        state.place = '';
        return;
      }
      throw err;
    }
  }

  async function refreshForecast() {
    if (!state.inUS || !state.point) return;
    const p = state.point.properties;
    const [daily, hourly] = await Promise.all([getJSON(p.forecast), getJSON(p.forecastHourly)]);
    state.daily = buildDays(daily.properties.periods || []);
    state.hourly = hourly.properties.periods || [];
  }

  async function refreshObs() {
    if (!state.inUS || !state.point) return;
    const found = await loadObservation(state.point.properties.observationStations);
    state.obs = found?.props || null;
    state.station = found?.station || '';
  }

  async function refreshAlerts() {
    if (!state.inUS || !state.location) return;
    const { lat, lon } = state.location;
    const data = await getJSON(`${NWS}/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`);
    state.alerts = data.features || [];
  }

  async function refreshWeather() {
    if (!state.location) return;
    try {
      if (!state.point && state.inUS) await loadPoint(state.location.lat, state.location.lon);
      await Promise.all([refreshForecast(), refreshObs(), refreshAlerts()]);
      state.problem = '';
      state.lastUpdate = Date.now();
    } catch (err) {
      // Keep whatever is already on screen; say plainly why it is not moving.
      state.problem = `Could not reach the National Weather Service: ${err.message}. Showing the last reading.`;
    }
    renderAll();
  }

  /* ── Polling ──────────────────────────────────────────────── */
  const timers = [];

  function startPolling() {
    stopPolling();
    timers.push(setInterval(refreshObs, REFRESH.obs));
    timers.push(setInterval(refreshForecast, REFRESH.forecast));
    timers.push(setInterval(refreshAlerts, REFRESH.alerts));
    timers.push(setInterval(refreshRadar, REFRESH.radar));
    timers.push(setInterval(renderAll, REFRESH.obs));
  }

  function stopPolling() {
    for (const t of timers.splice(0)) clearInterval(t);
  }

  /* ── Location ─────────────────────────────────────────────── */
  function storeLocation(loc) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(loc)); } catch { /* fine without it */ }
  }

  function readStoredLocation() {
    try {
      const loc = JSON.parse(localStorage.getItem(STORE_KEY));
      if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) return loc;
    } catch { /* nothing stored */ }
    return null;
  }

  async function useLocation(loc, { remember = true } = {}) {
    if (!loc) return;
    const changed = !state.location
      || state.location.lat !== loc.lat || state.location.lon !== loc.lon;
    state.location = loc;
    if (remember) storeLocation(loc);
    el.locate.hidden = true;

    if (!map) buildMap(loc.lat, loc.lon); else moveMap(loc.lat, loc.lon);
    if (changed) { state.point = null; state.inUS = true; }

    await refreshWeather();
    if (!state.frames.length) await refreshRadar();
    startPolling();
  }

  el.locGps.addEventListener('click', () => {
    if (!navigator.geolocation) { el.locHint.textContent = 'This browser offers no geolocation.'; return; }
    el.locHint.textContent = 'Asking the browser where we are…';
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => useLocation({
        lat: Number(coords.latitude.toFixed(4)),
        lon: Number(coords.longitude.toFixed(4)),
      }),
      (err) => { el.locHint.textContent = `The browser would not give a position: ${err.message}`; },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });

  el.locSave.addEventListener('click', () => {
    const lat = Number(el.locLat.value.trim());
    const lon = Number(el.locLon.value.trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      el.locHint.textContent = 'Latitude runs to ±90 and longitude to ±180.';
      return;
    }
    useLocation({ lat, lon });
  });

  /* ── The shell ────────────────────────────────────────────── */
  headunit.on('settings', (next) => {
    const before = JSON.stringify(state.units);
    if (next?.units) state.units = next.units;
    // A unit change only needs a redraw; the data behind it has not moved.
    if (JSON.stringify(state.units) !== before) renderAll();
    if (next?.location) useLocation(next.location, { remember: false });
  });

  /* A head unit left running on a mountain road should not keep hammering an
   * API it cannot reach, so polling and the radar loop stop when the app is
   * put in the background and pick up again when it comes forward. */
  headunit.on('background', () => { stopPolling(); stop(); });
  headunit.on('foreground', () => {
    startPolling();
    if (state.playing) play();
    refreshWeather();
  });

  headunit.ready((hu) => {
    if (hu.settings?.units) state.units = hu.settings.units;
    const loc = hu.settings?.location || readStoredLocation();
    if (loc) {
      useLocation(loc, { remember: !hu.settings?.location });
      return;
    }
    // Nothing saved anywhere: try the browser once, and ask only if that fails.
    el.locate.hidden = false;
    setStatus();
  });
})();
