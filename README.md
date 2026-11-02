# Binders Hub

From a note to production, with your coding agents. Self-hosted and open source.

An agentic development platform. Notes become work items, agents take them over MCP, their pull requests are approved
together in change sets, and every change is followed through CI and CD to production. GitHub keeps the work: cards
are issues in each binder's repo, and notes are Markdown in a Git repo.

- `hub/`: the server. A change log on Redis Streams; sign-in with GitHub; cards saved as GitHub Issues; GitHub's
  webhooks for issues, pull requests, checks, workflow runs and deployments; approving and merging change sets on
  GitHub; notes committed to Git; a live feed over WebSocket; and the MCP server agents connect to.
- `web/`: the web app. Flow, Notes (a Markdown editor with live preview, [[links]], tables and Mermaid, and Distill),
  each card full screen, Change sets, Delivery, Agents and Settings.
- `runner/`: keeps an agent taking cards on the machine where the code is (see below).
- `shared/`: what they all use: the model, the changes, and the code that applies them.
- `demo/`: a throwaway hub of invented data, and the site's screenshots taken from it (see its README).

## Self-host

This is the quickest way, with Docker Compose on one server. For plain Docker, Kubernetes with Helm, AWS ECS on
Fargate, or Node with systemd, see [docs/DEPLOY.md](docs/DEPLOY.md).

What you need: a Linux server with Docker and Docker Compose v2, an address for it with HTTPS (Caddy or nginx in front
of the hub, or a Cloudflare tunnel), and a GitHub account or organization for the hub's GitHub App. Your agents run on
your own machines, where your code is: the hub only hands them work.

1. **Get the code and the settings file.**

   ```sh
   git clone https://github.com/binders-io/binders-hub.git && cd binders-hub
   sudo mkdir -p /etc/binders /var/lib/binders
   sudo cp deploy/hub.env.example /etc/binders/hub.env     # then set PUBLIC_URL and HUB_SECRET in it
   ```

2. **Start it.** Behind Caddy or nginx on the same machine, the hub listens on `127.0.0.1:4400`:

   ```sh
   docker compose -f deploy/compose.yml -f deploy/compose.port.yml up -d --build
   ```

   A Caddyfile for it is two lines: `hub.example.com {` / `reverse_proxy 127.0.0.1:4400 }`. With a Cloudflare tunnel
   instead, put `TUNNEL_TOKEN=…` in `/etc/binders/tunnel.env` and run
   `docker compose -f deploy/compose.yml --profile tunnel up -d --build`.

3. **Open the setup link.** Nobody can sign in to a new hub yet, so it prints a one-time link:
   `docker compose -f deploy/compose.yml logs hub | grep -i setup`. Open it to become the hub's first admin.

4. **Connect GitHub**, in Settings → GitHub: create the hub's GitHub App (GitHub makes it and hands its keys straight
   back), install it on your repos, and sign in with GitHub. Then give your binder its repo in Settings → Binder. See
   [Connect GitHub](#connect-github).

5. **Add an agent**, in Agents: set one up and run the command it shows on the machine where your code is. That starts
   the [runner](#the-runner-agents-that-take-work-on-their-own), which takes cards with Claude Code, Codex or a command
   of your own.

Your data is in `/var/lib/binders` (Redis's append-only file and the hub's notes and secret): back it up with
`/etc/binders/hub.env`. To update, `git pull` and run the same `docker compose … up -d --build`, or let
`deploy/update.sh` do it from a timer (it runs the tests first, and follows whatever is on the branch it's given, so
point it at a tag or your fork). To look around first with invented data, see [demo/](demo/README.md).


## Run it on this Mac, to work on it

```sh
cd hub && npm install && npm run redis          # Redis on port 6390, kept in hub/.data/redis
cd hub && REDIS_URL=redis://127.0.0.1:6390 HUB_SECRET=something-long npm run dev   # the hub on port 4400
cd web && npm install && npm run dev            # the web app on port 5173; /api, /auth, /mcp go to the hub
```

With no GitHub app set up, the hub on this machine lets you sign in with a name. It starts with one binder and a
note on what to do first.

## Run it on a server

The `Dockerfile` builds the hub with the web app and the runner beside it; the hub serves the web app itself
(`WEB_DIR`), so one address carries everything. `deploy/compose.yml` runs it with Redis (an append-only file on disk)
and, with `--profile tunnel`, a Cloudflare tunnel that gives it its public address without opening a port:

```sh
# On the server: /etc/binders/hub.env holds PUBLIC_URL=https://… (and any other setting below),
# /etc/binders/tunnel.env holds TUNNEL_TOKEN=… for the tunnel. Data goes in /var/lib/binders.
docker compose -f deploy/compose.yml --profile tunnel up -d --build
```

`deploy/update.sh` keeps a server on the newest commit of its branch: run from a clone by a timer (a systemd timer or cron, every few minutes), it fetches, runs the tests
(`docker build --target test`), and rebuilds only when they pass. Optionally, `deploy/move.sh user@server` moves a hub on a
Mac there, with the hub here stopped: its secret (which seals GitHub's keys), its notes, and its Redis, copied key by
key (`hub/scripts/copy-redis.ts`), so the two Redis versions needn't match. Then add the new address's
`/auth/github/callback` to the GitHub App's callback URLs and point runners at it; the hub points the app's webhook at
itself when it starts.

## Binders on one hub

A hub holds binders. A binder is one notebook, as on the Mac: its folders and notes, its board, its GitHub repo and
its members, at its own address (`https://hub/mobile-app/`). Anyone signed in makes one, in the sidebar's switcher or
Settings → Binder, and owns it; its owners and admins add and remove people there. Everyone also gets a binder of
their own at `/~login`, which nobody else opens (the hub's admins included), its notes synced to a private
`<login>/binders-notes` repo once the hub's GitHub App is on their account. Sessions, apps' and agents' tokens and the
hub's options are the hub's; an agent's token belongs to the binder it was made in.

The first binder is the one a hub had before it held several (`HUB_SPACE`, `main` by default, or the one its store already has; named by
`HUB_NAME`). It keeps its folders and starts with no members, so whoever the hub let in still gets in; adding its first
member, as owner, closes it. In Redis each binder is `hub:<address>:…` and the hub's own keys are `hub:_hub:…`. In the
code a binder at its own address is a space, which holds one `binder` (its notes and board) as the log has always
called it; one made before a binder was one notebook may hold several, shown as its parts. A binder goes by its name in
both places: renaming either renames the other.

## Connect GitHub

The hub has one GitHub App, made and installed from the first binder's **Settings → GitHub**, and every binder made
since reaches GitHub through it, each linking its own repo: in its Settings → GitHub, **Use the hub's GitHub App**
lists the app's installations its owner can reach (an organization GitHub shows them in, or their own account), and
through the one picked the binder reaches only the repos it links. (A binder made earlier with an app of its own keeps it:
forgetting it leaves the others'.) Its webhook comes to `/webhooks/github/<binder>` (the first Binder's to
`/webhooks/github`), and each member connects their own GitHub to it, as a GitHub App's sign-in reaches only where that
app is installed. Three steps:

1. **Create on GitHub.** The hub describes the GitHub App it needs (signing in, the webhook and its secret, access to
   issues, pull requests, checks and Actions) and GitHub makes it on your account or an organization. GitHub hands its
   keys straight back to the hub, which keeps them sealed in its store. Nothing to copy.
2. **Install it on your repos.** Pick the repos; the hub mints its own short-lived token for each.
3. **Sign in with GitHub**, so approvals and merges happen as you. From then on people sign in this way: the app's
   owner, or the members of its organization (add more with `HUB_ALLOWED_USERS` / `HUB_ALLOWED_ORGS`).

Then give each binder its repo, in Settings → Binder. People sign in to the hub through the app of the Binder whose
address they're at (or the first Binder with one), and connect their GitHub to their other Binders from their account page (their picture, top right).

**Signing in, with a private GitHub App.** A private GitHub App lets only its own organization's members sign in
through it. To let anyone you allow sign in, add a GitHub OAuth App in **Settings → Access** (or set
`GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`): callback `https://your-hub/auth/github/callback`. It asks
GitHub only who people are; the hub's allowed people and each binder's members decide who gets in. What's done as
someone on repos (approving, merging, an agent pushing as its owner) still goes through the GitHub App, which each
person connects to from their account page (their picture, top right).

GitHub can't send events to a hub only this machine reaches, so on `localhost` the webhook starts off: signing in,
issues and merging work, but checks and deployments don't arrive. For those, put the hub behind a public address (a
tunnel such as `cloudflared tunnel --url http://localhost:5173` works), set `PUBLIC_URL` to it, and make the app there.

A hub that nobody can sign in to yet (not on this machine, no GitHub) prints a one-time setup link when it starts.

On `localhost` GitHub accepts neither a webhook nor webhook events, so the app is made without them, and the hub
follows GitHub by asking (see below).

To set up the first Binder's GitHub by hand instead, the `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_TOKEN`
and `GITHUB_WEBHOOK_SECRET` settings still work, and win over its app.

The hub's secret, which seals what it keeps, is `HUB_SECRET`, or `hub/.data/secret`, made the first time.

## Options

Settings → Options has the hub's switches, kept by the hub and taking effect at once: following GitHub by asking (while
no webhook arrives, always, or webhooks only, and how often), the pause before a note is committed, who may sign in,
who the admins are, and signing in by name. Only admins change them; until someone names admins, whoever can sign in
can. An environment variable fixes an option (Settings shows it as set on the hub): `HUB_POLL`, `HUB_POLL_SECONDS`,
`NOTES_QUIET_SECONDS`, `NOTES_LONGEST_MINUTES`, `HUB_ALLOWED_USERS`, `HUB_ALLOWED_ORGS`, `HUB_ADMINS`, `HUB_DEV_LOGIN`.

## When GitHub can't reach the hub

A hub on a Mac or behind a firewall gets no webhooks, so it asks GitHub instead, every 30 seconds by default: issues
and pull requests changed in its repos, the checks on the pull requests it follows, workflow runs, and deployments.
What it hears is handled exactly as a webhook would be; requests carry GitHub's ETags, so a quiet repo costs nothing
against the rate limit. When webhooks start arriving, it stops asking.

## The runner: agents that take work on their own

An agent like Claude Code only calls Binders while it's working on something you asked, so on its own it can't be given
work. The runner fixes that: it runs on the machine where the code is, stays connected to the hub as the agent (so a
new card reaches it within a second, and it shows as listening), and for each card starts the agent headless in the
workspace with Binders' tools attached. It relays what the agent does to the card as it goes; an agent that stops
without finishing, crashes or runs past its time limit puts the card back with why; and one that asks a person
something is started again on that card with the answer.

```sh
cd runner && npm install
BINDERS_TOKEN=bnd_… node src/main.ts --hub http://localhost:5173 --workspace ~/code/my-repo
```

Every card is worked in a worktree on a branch of its own (under `~/.binders/worktrees`), never in your own checkout: in
a repo, the card's worktree of it; in a folder of repos, a folder of the card's own laid out the same, with a worktree
of each. Its commits, pushes and pull requests are by the agent's owner (pushed with their sign-in to the hub, with
their GitHub name and private email) or, set so in its settings, by the hub's GitHub App. What it runs (Claude Code, Codex, or your own command), its access (full by
default: no prompts; Auto, where Claude Code decides what's safe; or edits only), its model and time limit are the
agent's runner settings, on the Agents page; the runner reads them before each card.

To keep agents running in the background instead, the hub's installer sets up the `binders` command and the agent in
one line (the Agents page's Start the runner gives it with the token filled in):

```bash
curl -fsSL https://your-hub/install | sh -s -- add --token bnd_… --workspace ~/code/my-repo
binders list            # every agent on this machine: running or not, its process, uptime, last log, folder
binders logs NAME -f    # what it's doing
binders restart NAME    # also stop, start, remove; --all for every one
```

Each runs as a service of yours (a LaunchAgent on a Mac, a `systemd --user` unit on Linux): it starts at login and
again after a crash, logs to `~/.binders/logs`, and keeps its token in `~/.binders/agents`, readable by you alone. On a
Mac, an agent working in `~/Documents` needs node allowed there once (macOS asks), and its tools' sign-ins (Claude Code,
Codex) done beforehand, as a background service can't show them.

Run as the file the hub hands out (`binders-runner.mjs`), the runner keeps itself current: when the hub has a newer
one and it's idle, it replaces its file and starts again on it, without being restarted by hand.

An agent that says nothing for 15 minutes (`--idle-minutes`, or its settings) is stopped as stuck, and its card,
debrief or Challenge says so: a model it can't reach, a prompt waiting in its own app, a login gone stale. Each runner
also tells the hub who it is, so a second runner for the same agent hears of the first when it starts, and the
Agents page says when more than one is running: they'd take the same work.

An agent reaches no more of GitHub than the person who set it up. It takes a card only in a repo its owner can push to,
as GitHub says with the owner's own sign-in (refused otherwise, with why, and not offered again for a while), and each
run gets a token of the GitHub App's for that one repo, for an hour, to read and push code and open pull requests
(`repo_token`; the runner renews it on long runs). The runner hands it to the agent's git through a credential helper,
with SSH addresses of that GitHub sent over HTTPS, and to gh as `GH_TOKEN`, so the machine's own GitHub login isn't
used. A hub without a GitHub App (a token set by hand) can't narrow a token: there the agent uses the machine's login,
and the runner's log says so.

Before a Challenge, the runner works out the change's blast radius in the reviewer's folder, with git alone: the
functions, types and exports it added, changed or removed (found by their shape in the diff and the hunks' headers),
their uses elsewhere that the change didn't touch (`git grep -w`), and the tests that mention them. The reviewer gets it
with the diff, and the Challenge shows it: a removed symbol still used, or a changed one whose callers weren't
updated, is where a change breaks. It's found by name, a first look rather than a proof.

### With an enterprise MCP config

Where an organization manages Claude Code's MCP servers (a `managed-mcp.json` in `/Library/Application Support/ClaudeCode/`
on a Mac, `/etc/claude-code/` on Linux, `C:\ProgramData\ClaudeCode\` on Windows), Claude Code refuses any other server,
the one the runner adds for each run included. The runner sees the file (or Claude Code saying so) and works without
Binders' MCP tools: Claude Code gets the plain prompts, the runner reports its steps and answers, and the Agents page says
so. To give it Binders' tools back, an admin adds the hub to the managed config:

```json
{ "mcpServers": { "binders_hub": { "type": "http", "url": "https://hub.example.com/mcp", "headers": { "Authorization": "Bearer ${BINDERS_TOKEN}" } } } }
```

`BINDERS_TOKEN` is the agent's token, which the runner sets for every run. The runner reads the managed config and
finds Binders' server there by its address (this hub's `/mcp`) or by the name `binders_hub`: Claude Code then uses
Binders' tools from it, and the runner adds no config of its own. (`BINDERS_MANAGED_MCP=allowed` says the same where
the runner can't read the managed config.) It also asks Claude Code which servers it has (`claude mcp list`): one at this hub's address, or named for Binders at an
`/mcp` path, counts too, so a hub this runner reaches at another address (localhost, say) is still recognised.

With no Binders server at all, an agent still does what a card asks of Binders: it ends its reply with the actions
(proposing a note's work items, making a card, adding to a note) as JSON, and the runner takes them with the agent's
own token.

The runner never uses the system's temp folder, which hardened machines lock down: files an agent writes (a note it
edits, a brief, its answers when it has no MCP tools) go in a `.binders` folder in the folder it works in, which git
ignores, and the runner's own in `~/.binders` (`BINDERS_HOME`).

## Connect an agent

In **Agents**, set one up: it gets a token, shown once, and the settings to paste into Claude Code, Codex, Claude
Desktop or any MCP client. The agent then calls `whoami`, `wait_for_work`, `claim_task`, `report_progress`, `ask` and
`complete_task` (the MCP server's instructions say how).

To try it without a real agent: `cd hub && HUB_URL=http://localhost:5173 BINDERS_TOKEN=bnd_… npm run stand-in`.

## Tests

`cd hub && npm test`: the log on memory and on a throwaway Redis (port 6391), the hub, notes in Git, sign-in with a
stand-in GitHub, the live feed, agents over MCP from finding work to shipping it, GitHub's webhooks, and Redis going
away and coming back.

`cd runner && npm test`: taking work, worktrees and the blast radius.

`cd web && npm test`: what's waiting and the live feed (`sync.ts`), the store, the board, the editor, a screen that
won't load, where focus goes, and axe over every screen with each text tone on each surface. After `npm run build`, `npm run budget` adds up what a browser fetches on opening the app, which has to stay
under 350 KB gzipped. All of this runs in `docker build --target test`, so it holds a deploy back too.

## Running it in production

`LOG=1` puts every request in the log, by method and path only; what goes wrong is logged either way, as JSON lines, and
`LOG_LEVEL` sets how much. The content security policy starts out reporting what it would stop, in the browser's
console: `CSP_ENFORCE=1` turns it on once that's been quiet. Sign-in is rate limited per address. Forwarded addresses (`X-Forwarded-For`, and
`cf-connecting-ip` from a Cloudflare tunnel) are believed only from proxies on the machine or a private network;
`TRUST_PROXY` names others (`true`, or addresses and ranges).

An agent is its owner's: only they can change what it runs on their machine or take a token for it. A Binder's owners and
admins can still rename it, point it elsewhere or revoke it.

## License

Copyright (C) 2026 Binders. [AGPL-3.0](LICENSE). You may run, change and share Binders Hub; if you run a changed version for others over a
network, offer them its source (section 13).
