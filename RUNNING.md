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

Texas Hold'em against four opponents, all of it running in the page. No
network, no account, nothing to sign into — it works in a driveway with no
signal, and nobody else's site can break it.

Open Face Chinese is next; the menu shows it greyed out. The hand evaluator it
needs is already written and tested.

### Checking the rules for yourself

The parts that must be right are testable from the command line, without
starting the head unit:

```
node apps/poker/web/engine/evaluate.test.mjs
node apps/poker/web/engine/holdem.test.mjs
node apps/poker/web/engine/ai-holdem.test.mjs
```

The first one ranks **every five-card hand there is** — all 2,598,960 — and
checks the totals against the distribution the maths says they must have: 40
straight flushes, 624 four-of-a-kinds, 3,744 full houses, and so on down. One
hand ranked wrongly moves a count and the test fails. It takes about a second.

The second plays four thousand random hands and proves the chips that come out
equal the chips that went in, then checks side pots by hand — a short stack all
in against two deeper ones, and dead money from somebody who folded after
betting.

The third checks the bots' arithmetic against published poker figures: pocket
aces win 85.2% against a random hand heads-up, seven-deuce offsuit 34.6%. The
rollout lands within a point of each. If it ever stops doing that, the bots are
broken no matter how they feel to play against.

### The opponents

Five personalities, four at the table: a rock who folds too much, a maniac who
raises too much, and three in between. Each works out its equity by dealing the
rest of the hand out a few hundred times and counting how often it wins, then
weighs that against the pot odds. The differences between them are appetite for
aggression and a willingness to bluff, which is what stops the table playing
like one player copied four times.

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
