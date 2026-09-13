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

## Poker

Texas Hold'em and Open Face Chinese, against actual people. The app writes no
poker of its own — it is a way in to tables hosted elsewhere, because the games
worth playing are the ones with somebody else at them, and nobody is installing
anything to sit at a table with you.

Make a table on your phone, send the link to whoever is playing, and open the
same link here. Links you open are kept in the lobby so a regular game is one
tap next time.

Every venue listed was checked for one thing: whether it sends
`X-Frame-Options` or a `Content-Security-Policy: frame-ancestors`, either of
which makes it impossible to show inside this OS. Those that refused — Board
Game Arena and unmasked.poker — are named in the lobby rather than quietly left
out, so nobody rediscovers them and wonders why they were missed.

**Those headers belong to other people.** A venue can start refusing to be
framed at any time, and a table that has always worked will go blank with no
warning. There is nothing this end can do about that, and nothing it can
detect either: a frame that was refused, one that never loaded, and one that
simply has not painted yet are identical from inside the page. So the app does
not guess. The **Blank?** button in the table bar explains the situation to the
one party who can actually see the screen.

**Kosmi's video chat will not work yet.** It needs camera and microphone, and
the shell frames apps with no permissions list at all, so there is nothing for
this app to hand on. The table itself plays fine without it. Fixing it properly
means letting a manifest ask for permissions and having the shell put them on
the frame — worth doing when something else needs it too.

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
