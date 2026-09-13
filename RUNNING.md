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

## The boot animation

Ribbons sweep in and wrap into your vehicle's emblem, then the launcher. It
plays for about six and a half seconds and **a tap anywhere skips it**.

It needs one file you supply: **`shell/assets/emblem.png`** — a transparent PNG,
600px or wider on the long edge. Without it the splash simply does not run and
the head unit boots straight to the launcher; Settings says so under the Boot
animation switch.

Turn it off in Settings &rarr; Display. For development, `?nosplash` on the URL
skips it without changing the setting:

```
http://localhost:4100?nosplash
```

### If the emblem arrives with a background

Copying an image that has transparency and saving it from a preview usually
bakes the grey-and-white checkerboard into the pixels. It looks right as a
thumbnail and composites as a grey rectangle behind the badge. Windows will
also quietly name the file `emblem.png.png` if extensions are hidden.

Best fix is to download the actual file — right-click the image itself and
*Save image as…* — rather than saving a preview of it. Failing that:

```
node tools/cutout.mjs shell/assets/emblem.png
```

It reads the background off the border of the image and removes only the part
connected to the edge, so white lettering inside the badge is never touched,
then feathers and un-blends the antialiased rim. Your original is kept beside
it as `emblem.original.png`, and running it twice does nothing.

Two knobs if the first pass is not right. `--tolerance` (default 8) is how
close a colour must be to count as background: raise it if a pale fringe
survives, lower it if the cut bites into the artwork. `--feather` (default 1)
is how wide the blended edge is.

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
