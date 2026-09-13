/*
 * The lobby, and the frame that holds a table.
 *
 * Nothing here knows the rules of poker. What it knows is which venues can be
 * shown inside another page, how to get back out of one, and how to keep the
 * handful of tables you actually use within one tap.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    lobby: $('lobby'), table: $('table'), frame: $('frame'),
    back: $('back'), reload: $('reload'), tableName: $('tableName'),
    holdem: $('holdem'), ofc: $('ofc'), blockedList: $('blockedList'),
    savedBlock: $('savedBlock'), savedList: $('savedList'),
    addForm: $('addForm'), addUrl: $('addUrl'), addError: $('addError'),
    help: $('help'), note: $('frameNote'), noteTitle: $('frameNoteTitle'),
    noteBody: $('frameNoteBody'), noteDismiss: $('frameNoteDismiss'),
  };

  /* Venues, and why each one is here.
   *
   * `embeds` records what the site's headers said when this was written, not
   * what they say today. It is a claim with a date on it, and the frame is
   * built to cope with it having gone stale rather than to trust it. */
  const VENUES = [
    {
      game: 'holdem', id: 'pokernow', name: 'Poker Now',
      url: 'https://www.pokernow.com/',
      blurb: 'The one most home games end up on. Make a table, send the link, they are dealt in — no account.',
      embeds: true,
    },
    {
      game: 'holdem', id: 'kosmi', name: 'Kosmi',
      url: 'https://kosmi.io/poker/',
      blurb: 'Up to ten, with video chat at the table. You pick the room name, which matters when you are typing it on a touchscreen.',
      embeds: true,
    },
    {
      game: 'ofc', id: 'pineapple', name: 'Pineapple OFC',
      url: 'https://pineappleofcpoker.raccoons.lv/',
      blurb: 'Pineapple open face with Fantasyland. The modern rules — three cards a turn, place two, pitch one.',
      embeds: true,
    },
    {
      game: 'ofc', id: 'ftr', name: 'Flop Turn River',
      url: 'https://flopturnriver.com/ofc/',
      blurb: 'Classic open face and Pineapple, free, against people or the computer.',
      embeds: true,
    },
  ];

  const BLOCKED = [
    { name: 'Board Game Arena', why: "sends frame-ancestors 'self' and X-Frame-Options: SAMEORIGIN" },
    { name: 'unmasked.poker', why: "sends frame-ancestors 'self' and X-Frame-Options: SAMEORIGIN" },
  ];

  /* ── Saved tables ────────────────────────────────────────── */

  const STORE_KEY = 'headunit.poker.tables';

  function readSaved() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((t) => t && typeof t.url === 'string') : [];
    } catch {
      /* A corrupt or unreadable store must not take the lobby down with it —
         losing the shortcuts is a nuisance, a blank screen is a fault. */
      return [];
    }
  }

  function writeSaved(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* private mode */ }
  }

  /** A short, honest label for a table link, since the URLs are unreadable. */
  function labelFor(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      const tail = u.pathname.split('/').filter(Boolean).pop();
      return tail && tail.length <= 24 ? `${host} · ${tail}` : host;
    } catch { return url; }
  }

  function renderSaved() {
    const list = readSaved();
    el.savedBlock.hidden = list.length === 0;
    el.savedList.replaceChildren(...list.map((t) => {
      const row = document.createElement('div');
      row.className = 'saved-row';

      const open = document.createElement('button');
      open.className = 'saved-open';
      open.type = 'button';
      open.textContent = t.label || labelFor(t.url);
      open.addEventListener('click', () => openTable(t.url, t.label || labelFor(t.url)));

      const drop = document.createElement('button');
      drop.className = 'saved-drop';
      drop.type = 'button';
      drop.setAttribute('aria-label', `Forget ${t.label || t.url}`);
      drop.textContent = '✕';
      drop.addEventListener('click', () => {
        writeSaved(readSaved().filter((x) => x.url !== t.url));
        renderSaved();
      });

      row.append(open, drop);
      return row;
    }));
  }

  function remember(url, label) {
    const list = readSaved().filter((t) => t.url !== url);
    list.unshift({ url, label });
    writeSaved(list);
    renderSaved();
  }

  /* ── The lobby ───────────────────────────────────────────── */

  function venueCard(v) {
    const card = document.createElement('button');
    card.className = 'venue';
    card.type = 'button';

    const name = document.createElement('span');
    name.className = 'venue-name';
    name.textContent = v.name;

    const blurb = document.createElement('span');
    blurb.className = 'venue-blurb';
    blurb.textContent = v.blurb;

    card.append(name, blurb);
    card.addEventListener('click', () => openTable(v.url, v.name));
    return card;
  }

  el.holdem.replaceChildren(...VENUES.filter((v) => v.game === 'holdem').map(venueCard));
  el.ofc.replaceChildren(...VENUES.filter((v) => v.game === 'ofc').map(venueCard));
  el.blockedList.replaceChildren(...BLOCKED.map((b) => {
    const li = document.createElement('li');
    li.textContent = `${b.name} — ${b.why}`;
    return li;
  }));

  /* ── Opening a table ─────────────────────────────────────── */

  function openTable(url, label) {
    el.note.hidden = true;
    el.tableName.textContent = label;
    el.frame.src = url;
    el.lobby.hidden = true;
    el.table.hidden = false;
    /* The site wants the whole screen; the shell's rail would only crowd it. */
    if (window.headunit) { headunit.setImmersive(true); headunit.setTitle(label); }

    /* Nothing about the outcome is observable from here, and two plausible
     * ways of detecting it were tried and measured before settling for that.
     *
     * Reading frame.contentWindow.location is supposed to succeed on a frame
     * blocked by X-Frame-Options, because it stays same-origin on about:blank.
     * Against a server really sending X-Frame-Options: DENY it throws
     * SecurityError, exactly as a page that loaded fine does.
     *
     * Waiting for `load` is no better: it fires for a page that rendered, for
     * one that refused to be framed, and for a connection that was refused
     * outright — checked against a dead port.
     *
     * So this guesses at nothing and nags about nothing. The explanation lives
     * behind the Blank? button in the bar, for the person who can see the one
     * thing this code cannot: whether there is a game on the screen. */
  }

  function showNote(url) {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* leave it */ }
    el.noteTitle.textContent = 'Nothing showing?';
    el.noteBody.textContent =
      `Either ${host} is refusing to be shown inside another page, or nothing ` +
      'came back from it at all. Those look identical from in here, so this is ' +
      'not a diagnosis. Try Reload; if it stays empty, open the table in a ' +
      'browser on your phone. The link is saved either way.';
    el.note.hidden = false;
  }

  el.noteDismiss.addEventListener('click', () => { el.note.hidden = true; });
  el.help.addEventListener('click', () => {
    if (!el.note.hidden) { el.note.hidden = true; return; }
    showNote(el.frame.src || '');
  });

  function closeTable() {
    el.note.hidden = true;
    /* Blank the frame on the way out. Left loaded it keeps a socket open to
       somebody's game server for as long as the head unit is running. */
    el.frame.src = 'about:blank';
    el.table.hidden = true;
    el.lobby.hidden = false;
    if (window.headunit) { headunit.setImmersive(false); headunit.setTitle('Poker'); }
  }

  el.back.addEventListener('click', closeTable);
  el.reload.addEventListener('click', () => {
    const src = el.frame.src;
    if (src && src !== 'about:blank') { el.frame.src = 'about:blank'; el.frame.src = src; }
  });

  /* ── Open by link ────────────────────────────────────────── */

  el.addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const raw = el.addUrl.value.trim();
    if (!raw) return;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return fail('That does not look like a link.');
    }
    /* Only http(s). A javascript: or data: URL in a frame is somebody else's
       script running with this app's origin, and this box is one paste away
       from whatever was last on the clipboard. */
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return fail('Only web links can be opened here.');
    }
    el.addError.hidden = true;
    el.addUrl.value = '';
    const label = labelFor(url.href);
    remember(url.href, label);
    openTable(url.href, label);
  });

  function fail(message) {
    el.addError.textContent = message;
    el.addError.hidden = false;
  }

  /* ── Shell ───────────────────────────────────────────────── */

  renderSaved();

  if (window.headunit) {
    headunit.ready(() => headunit.setTitle('Poker'));
    /* Leaving the app should not leave a table running in the background. */
    headunit.on('background', () => { if (!el.table.hidden) closeTable(); });
  }
})();
