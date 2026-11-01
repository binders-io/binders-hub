# The demo hub

A hub to look at: everything in it is invented, and it's gone when it stops. It's what the site's pictures of the Hub
are taken from, so they never come from a real hub.

- `data.ts`: what it holds. Harbor and its people are the same made-up team as the Mac app's demo. One piece of work runs
  through every screen: the note on annual plans, its cards, change set #11 on staging waiting for production, and change
  set #12 in review with its Challenge and debrief. Dates are counted back from when it runs.
- `hub.ts`: starts it. It keeps everything in this process and reads no settings from the environment, so it can't open a
  real hub's Redis, notes or keys. It listens on 127.0.0.1 only, and its GitHub is a port nothing answers on. The screens
  are told GitHub is connected, so they read as a set-up hub's, and what you approve or promote is only recorded.
- `shoot.ts`: takes the pictures.

## Set up

```sh
(cd hub && npm install) && (cd web && npm install)
cd demo && npm install && npx playwright install chromium
```

## Look around

```sh
cd demo
npm run build --prefix ../web    # it serves web/dist, as a real hub does
npm run hub                      # on port 4480, or: npm run hub -- 4500
```

Open the address it prints and sign in as `maya`. `startDemoHub(port)` in `hub.ts` does the same from a script, and gives
back the running `hub` for changes to land while a page is open.

## Take the pictures

```sh
cd demo
npm run shots -- ../../app/site/assets    # the folder is site/assets in your clone of binders-io/app
```

It builds the web app, starts a fresh demo hub on a free port, and writes these at 2400×1500 as WebP, in light and with
a `-dark` suffix in dark:

| Picture | Screen |
|---|---|
| `hub-flow` | Work: the board |
| `hub-card` | A card an agent is working on |
| `hub-change-set` | Change set #12, its pull requests in merge order |
| `hub-challenge` | Change set #12's Challenge |
| `hub-delivery` | Delivery: staging, production and the runs |

The Hub film's pictures are larger (a 1440×900 window at 2×, so 2880×1800) and of more screens: Home, Work, the note on
Distill, the card and its steps, the blocked card's question, change set #12's debrief and Challenge, Delivery, Agents
and Settings → Repo briefs, as `shot-<screen>-light.webp` and `shot-<screen>-dark.webp`:

```sh
npm run shots -- ~/Documents/reelkit/films/hub-flow/assets film
```

It stops without writing the picture if the page holds anything real (this machine's name and paths, your name and email
from git, the real team's names, anything shaped like a token), or if the page asks for anything that isn't the demo hub.
Look at them anyway: that check reads the page's words, not what a picture of it shows.

## Changing it

`npm test` checks the data holds together and names nothing real, and `npm run typecheck` checks it against the hub's
types. A new screen goes in `shots` in `shoot.ts`. Never point any of this at a real hub.
