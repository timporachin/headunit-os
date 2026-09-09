/*
 * YouTube app server.
 *
 * Two jobs: host the UI in web/, and expose a small JSON API over InnerTube
 * (youtubei.js) for search and metadata.
 *
 * The division of labour is the whole design. InnerTube is a private API: it
 * is not promised to anyone, and it moves. Playback therefore does NOT go
 * through it — the UI plays via YouTube's official IFrame embed, which is
 * supported and stable. This server only ever answers "what videos exist".
 *
 * So the failure mode is graceful. If InnerTube shifts under us, search breaks
 * and everything already in the library still plays. A player that dies mid-
 * drive is the failure we are not willing to have.
 *
 * Stream URLs are deliberately never touched. youtubei.js can produce them and
 * they are a trap: IP-locked, throttled, and gated behind bot detection that
 * YouTube actively maintains.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Innertube } from 'youtubei.js';

const PORT = Number(process.env.PORT) || 4310;
const WEB = path.join(import.meta.dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

/* One InnerTube session, created on first use and reused.
 * `retrieve_player: false` skips fetching and parsing YouTube's player script.
 * That work exists only to decipher stream URLs, which this server never wants,
 * and skipping it takes seconds off the first request. */
let session = null;
let creating = null;
async function innertube() {
  if (session) return session;
  if (!creating) {
    creating = Innertube.create({ retrieve_player: false })
      .then((yt) => { session = yt; return yt; })
      .finally(() => { creating = null; });
  }
  return creating;
}

/*
 * Thumbnails are served through this app rather than fetched from Google by the
 * browser. Two reasons: the page then needs no third-party connection just to
 * draw a list, and it keeps working in a browser whose outbound access is
 * restricted while the server's is not.
 *
 * The host allowlist is not decoration. Without it this endpoint is an open
 * proxy that will fetch anything for anyone who can reach the port.
 */
const THUMB_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com', 'yt3.ggpht.com', 'i9.ytimg.com']);

const proxiedThumb = (url) => (url ? `/api/thumb?u=${encodeURIComponent(url)}` : '');

/** Best available thumbnail, with a URL that needs no API and always exists. */
function pickThumb(video, id) {
  const thumbs = Array.isArray(video?.thumbnails) ? video.thumbnails : [];
  // Prefer something around card size rather than the largest available.
  const sorted = [...thumbs].sort((a, b) => (a.width || 0) - (b.width || 0));
  const chosen = sorted.find((t) => (t.width || 0) >= 320) || sorted.at(-1);
  return proxiedThumb(chosen?.url || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''));
}

/**
 * Flatten a "LockupView" — YouTube's newer card shape, which shares nothing
 * with the classic one: the id lives in content_id, the title under metadata,
 * and the author and view count are positional rows of text parts.
 *
 * Related videos arrive exclusively in this shape, so without this branch the
 * related list is silently empty rather than visibly broken — which is how it
 * got missed the first time.
 */
function normaliseLockup(item) {
  const id = item?.content_id ?? '';
  const rows = item?.metadata?.metadata?.metadata_rows ?? [];
  const rowText = (i) => (rows[i]?.metadata_parts ?? [])
    .map((part) => part?.text?.text ?? part?.text ?? '')
    .filter(Boolean)
    .join(' · ');
  const image = item?.content_image?.image;
  return {
    id,
    title: item?.metadata?.title?.text ?? '',
    author: rowText(0),
    duration: '',
    published: '',
    views: rowText(1),
    thumb: proxiedThumb((Array.isArray(image) ? image[0]?.url : '') || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '')),
  };
}

/**
 * Flatten an InnerTube video into the only shape the UI knows about.
 *
 * Everything the client sees is built here, so a change in InnerTube's own
 * shapes is a change to one function rather than a change to the interface.
 */
function normalise(video) {
  if (video?.type === 'LockupView') return normaliseLockup(video);
  const id = video?.id ?? video?.video_id ?? '';
  return {
    id,
    title: video?.title?.text ?? '',
    author: video?.author?.name ?? '',
    // Live streams report seconds: 0 and no text; say "LIVE" rather than "0:00".
    duration: video?.duration?.text ?? (video?.duration?.seconds ? '' : 'LIVE'),
    published: video?.published?.text ?? '',
    views: video?.short_view_count?.text ?? video?.view_count?.text ?? '',
    thumb: pickThumb(video, id),
  };
}

const sendJson = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

async function handleApi(res, url) {
  const route = url.pathname.replace(/^\/api\//, '');
  const q = (url.searchParams.get('q') || '').trim();

  if (route === 'search') {
    if (!q) return sendJson(res, 400, { error: 'a search needs a q parameter' });
    const yt = await innertube();
    const found = await yt.search(q, { type: 'video' });
    const videos = (found.videos || []).map(normalise).filter((v) => v.id);
    return sendJson(res, 200, { query: q, videos });
  }

  if (route === 'suggest') {
    if (!q) return sendJson(res, 200, { suggestions: [] });
    const yt = await innertube();
    const suggestions = await yt.getSearchSuggestions(q);
    return sendJson(res, 200, { suggestions: (suggestions || []).slice(0, 8) });
  }

  if (route === 'thumb') {
    const raw = url.searchParams.get('u') || '';
    let target;
    try {
      target = new URL(raw);
    } catch {
      return sendJson(res, 400, { error: 'not a url' });
    }
    if (target.protocol !== 'https:' || !THUMB_HOSTS.has(target.hostname)) {
      return sendJson(res, 403, { error: 'that host is not a thumbnail host' });
    }
    const upstream = await fetch(target, { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok || !upstream.body) {
      return sendJson(res, 502, { error: `thumbnail fetch failed (${upstream.status})` });
    }
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'image/jpeg',
      // Thumbnails for a given video do not change; let the browser keep them.
      'cache-control': 'public, max-age=86400',
    });
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    return res.end();
  }

  if (route.startsWith('video/')) {
    const id = route.slice('video/'.length);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return sendJson(res, 400, { error: 'not a video id' });
    const yt = await innertube();
    const info = await yt.getInfo(id);
    const basic = info.basic_info || {};
    return sendJson(res, 200, {
      id,
      title: basic.title ?? '',
      author: basic.author ?? '',
      views: basic.view_count ? `${basic.view_count.toLocaleString()} views` : '',
      thumb: pickThumb(basic, id),
      related: (info.watch_next_feed || []).map(normalise).filter((v) => v.id).slice(0, 24),
    });
  }

  return sendJson(res, 404, { error: 'no such endpoint' });
}

async function sendFile(res, file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(res, url);
      } catch (err) {
        // InnerTube failing is news about YouTube, not a crash in this app, so
        // it is reported as data the UI can explain rather than a dead request.
        console.warn(`[youtube] ${url.pathname}: ${err.message}`);
        return sendJson(res, 502, { error: `YouTube did not answer: ${err.message}` });
      }
    }

    const rel = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(WEB)) { res.writeHead(403).end('forbidden'); return; }
    if (await sendFile(res, file)) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(`server error: ${err.message}`);
  }
}).listen(PORT, 'localhost', () => {
  console.log(`YouTube app on http://localhost:${PORT}`);
});
