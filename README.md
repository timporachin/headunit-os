# Head Unit OS

A touchscreen operating system for a vehicle head unit, built one screen at a time.

The whole design rests on one decision: **an app is a URL, not a JavaScript module.**

Each app runs as its own process on its own port, and the shell hosts it in a frame.
That is what makes the system versatile — any project that can serve itself over HTTP
is installable here with no porting, no build integration, and no changes to its code.
God's Eye View runs unmodified this way, all 26 of its `/api/*` proxy routes intact.

The alternative (module federation, single-spa, one big bundle) buys smoother
transitions and costs you every app you did not write yourself. Not worth it.

## Run it

```
setup.cmd                      # first time only: fetches the vendored apps
npm start                      # shell on http://localhost:4100
```

**[RUNNING.md](RUNNING.md)** covers kiosk mode, the Windows gotchas, and what to do
when a screen misbehaves. It is the one place that answers "how do I run this".

No dependencies — the shell is plain Node and plain browser JavaScript. Apps bring
their own.

## Installing an app

Create `apps/<id>/app.json`. There are three kinds.

**`process`** — a repo that runs its own server. The shell spawns it and hands it a port.

```json
{
  "id": "gods-eye",
  "name": "God's Eye View",
  "icon": "🌐",
  "kind": "process",
  "cwd": "vendor/gods-eye-view",
  "start": "npm run dev",
  "portEnv": "PORT",
  "immersive": true
}
```

**`static`** — a folder of files, served on a port of its own.

```json
{ "id": "system", "name": "System", "icon": "⚙", "kind": "static", "dir": "." }
```

**`external`** — something already running elsewhere.

```json
{ "id": "grafana", "name": "Grafana", "icon": "📈", "kind": "external", "url": "http://localhost:3000" }
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase, dashes. Must match the folder name's intent; it is the app's address. |
| `immersive` | The app owns the whole screen; the nav rail collapses to an edge tab. |
| `boot` | `on-demand` (default) or `eager` to start with the shell. |
| `portEnv` | Which environment variable tells the app its port. Vite uses `PORT`. |
| `startTimeoutMs` | How long to wait for the port to answer before calling it failed. |

Apps start lazily. A head unit has to reach its launcher in a second or two, and a
Cesium globe takes far longer than that to boot, so nothing but `eager` apps pay at
startup. An opened app's frame stays alive in the background, so returning to it is
instant.

### Adding God's Eye View

`setup.cmd` clones it and installs its dependencies. By hand it is:

```sh
git clone https://github.com/bilawalsidhu/gods-eye-view vendor/gods-eye-view
cd vendor/gods-eye-view && npm ci && cd ../..
```

It needs Node 24.14+ or 26.x and a real GPU — it is Cesium with photorealistic 3D
tiles. It runs keyless; add a Cesium ion token or Google Maps key in its own
POWER UP panel for photoreal 3D, and note that ion's photoreal tier is licensed for
personal, non-commercial use.

## Making a page feel like the OS

Two optional files, both served from the shell's origin:

```html
<link rel="stylesheet" href="http://localhost:4100/design/tokens.css">
<script src="http://localhost:4100/sdk/headunit.js"></script>
```

`tokens.css` carries the day/night palette, the type scale, and the touch sizing.
The numbers are driven by the room: read at arm's length, in a moving vehicle, by
someone who should be looking at the road. Never put a target under `--touch-min`.

`headunit.js` is the bridge. It is entirely opt-in — an app that never loads it still
works as a page, which is exactly what lets you drop in a repo you did not write.

```js
headunit.ready((hu) => {
  hu.theme;              // 'night' | 'day', synced with the shell
  hu.vehicle;            // { speed, unit, gear, parked, source }
  hu.settings;           // { units: { speed, temp }, vehicleName, location }
  hu.setTitle('Radar');  // the shell's status bar
  hu.setImmersive(true); // take the full screen
  hu.open('gods-eye');   // switch apps
  hu.toast('Saved');     // a message in the shell's chrome, survives an app redraw
});

headunit.on('theme', (t) => { /* … */ });
headunit.on('settings', (s) => { /* redraw in the new units */ });
headunit.on('background', () => { /* pause expensive work */ });
```

`hu.settings` is what the driver chose on the settings screen. Read it instead of
shipping your own unit toggle: there should be one place on the head unit to
change this, and it is Settings. `location` is the home position, which may be
null. Brightness and the wake lock are the shell's own business and are not sent.

**Settings is a shell screen, not an app.** It is reached from the gear beside the
clock, and it is chrome rather than an app because every control on it changes the
shell itself — the name in the status bar, a dimmer that has to paint over an app's
frame, the units above. None of that is reachable from inside an app's own origin.
It also carries a start/stop/log panel for every installed app, which is how you
recover one that is wedged.

**Vehicle data is not wired up yet.** No CAN bus, no GPS. The shell reports
`source: "unavailable"` and `speed: null` rather than handing a page a plausible
number it might put in front of a driver. Check `source` before you trust a value.

## Layout

```
server/     shell server, app registry, process supervisor
shell/      the shell UI — status bar, nav rail, launcher, frame host
sdk/        headunit.js, the opt-in app bridge
design/     tokens.css, the design system
apps/       one folder per installed app, each with an app.json
vendor/     third-party app checkouts (gitignored)
```

## Why apps are cross-origin

Each app gets its own port rather than a path under the shell. Two reasons, and
the first is decisive: an app that fetches an absolute path — God's Eye View asks
for `/api/opensky` — resolves it against its own origin. Path-prefixing would send
those requests to the shell instead, and they would fail silently. The second is
containment: a third-party app cannot reach into the shell's DOM or storage, and a
crashed app takes down its own frame rather than the whole head unit.

The shell identifies a frame by its window object rather than by anything the frame
claims about itself, so an app cannot impersonate another one over the bridge.
