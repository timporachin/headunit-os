# Running the head unit

Everything in one place: getting it up, putting it on the truck's screen, and
what to try when something sticks.

## First time

You need [Node](https://nodejs.org) (LTS, 20.11 or newer — 24+ if you want
God's Eye View) and [git](https://git-scm.com). Then:

```
setup.cmd
```

That fetches the two apps that are not in this repo. They live under `vendor/`
and are deliberately untracked so each stays on its own upstream and can be
updated independently — which also means a fresh copy of this folder arrives
without them, and the launcher will look half-empty until you run it.

It only clones and installs. It deletes nothing, and re-running it is safe.

On anything that is not Windows, the same three steps by hand:

```sh
git clone --depth 1 https://github.com/bilawalsidhu/gods-eye-view vendor/gods-eye-view
git clone --depth 1 https://github.com/timporachin/norcal-bite-index vendor/norcal-bite-index
cd vendor/gods-eye-view && npm ci && cd ../..
```

## Every time

```
npm start
```

The shell comes up on <http://localhost:4100>. Apps are started on demand, each
on its own port from 4200 up; nothing but the shell runs until you open it.

## On the truck's screen

```
msedge.exe --kiosk http://localhost:4100 --edge-kiosk-type=fullscreen --no-first-run
```

Chrome works the same way with `--kiosk http://localhost:4100`. Use `localhost`
rather than `127.0.0.1`: some apps restrict who may frame them and are told to
trust both spellings, but the theme and the saved settings are stored per
origin, so switching between the two looks like losing your preferences.

## When something sticks

**The globe loads part-way and stalls, or a black console window appears.**
Almost always a leftover process from a previous run. Open Settings (the gear
beside the clock) and use the Apps panel to stop and restart it. If that does
not do it, end every stray `node.exe` in Task Manager, then delete
`vendor\gods-eye-view\node_modules\.vite` — two copies of Vite writing one
dependency cache produces exactly this.

**`npm` will not run from PowerShell.** The default execution policy blocks
`npm.ps1`. Use `npm.cmd start`, or allow signed scripts once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**An app says it could not start.** Settings → Apps → Log shows what it
actually printed. That is usually the whole answer.

**A screen looks stale.** Apps keep running in the background so returning to
one is instant; that is deliberate. Stop it in the Apps panel to force a fresh
boot.

## The Family screen

It signs in to a location service and keeps only a token, in
`apps/family/secrets.json` — never a password, never committed, readable only
by you. To check whether the service still works for your account without
starting the whole OS:

```
node apps/family/selftest.mjs
```

It prints your circles and member counts and no secret. If the screen ever goes
blank, run this first: it tells you whether the problem is the screen or the
service.

Life360 has no public API. If it stops working one day, that is why — the fix
is a second provider behind the same screen, not a rewrite. See
`apps/family/providers/index.mjs`.

## The Now Playing screen

Your phone plays the music, over Bluetooth, the same as any car stereo. The head
unit only reads what is playing and puts the controls within reach. Pair the
phone, play something, and it appears.

To check the source without starting the whole OS:

```
node apps/nowplaying/selftest.mjs
```

It runs the same adapter the app runs and reports what Windows says. If the
screen is ever blank, run this first: it tells you whether the problem is the
screen or the source. Add `--track` to print the actual title and artist rather
than just confirming they arrived.

| Variable | Meaning |
| --- | --- |
| `HEADUNIT_MEDIA` | `windows` (the default on Windows), `demo` for a fake track while developing, `off`. |
| `HEADUNIT_MEDIA_ARTWORK` | `itunes` turns on album-art lookup. Off by default, because it means telling Apple what you are listening to. |

**It needs Windows PowerShell 5.1** (`powershell.exe`), which ships with Windows
— not PowerShell 7 (`pwsh.exe`). Awaiting the WinRT call that reads the media
session depends on an extension .NET Core dropped. The app invokes the right one
on its own; this only matters if you run the adapter by hand.

**What Bluetooth gives you is thinner than you would expect**, and the screen is
built around that rather than papering over it. Album art almost never arrives —
AVRCP's cover-art profile is rarely negotiated — so the sleeve falls back to a
colour derived from the track itself. Position is often missing, so the progress
bar hides rather than sitting frozen at zero. Controls the phone refuses are
dimmed rather than left live and doing nothing.

Reading a phone depends entirely on what the host OS chooses to expose, so if
this ever moves off Windows the fix is a second provider behind the same screen,
not a rewrite. See `apps/nowplaying/providers/index.mjs`.

## Where things are

```
server/       shell server, app registry, process supervisor
shell/        the shell UI - status bar, rail, launcher, frame host, settings
design/       tokens.css, the palette and the touch sizing
sdk/          headunit.js, the optional bridge an app can adopt
apps/<id>/    one folder per app, each with an app.json manifest
vendor/       third-party checkouts, not tracked by git
```

Adding an app is one `app.json`. See `README.md` for the three kinds and why an
app is a URL rather than a module.
