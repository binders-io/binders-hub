# Binders Hub

From a note to production, with your coding agents. Self-hosted and open source.

An agentic development platform. Notes become work items, agents take them over MCP, their pull requests are approved
together in change sets, and the hub follows each change through its checks and deployments on GitHub. GitHub keeps the
work: cards are issues in each binder's repo, and notes are Markdown in a Git repo.

- `hub/`: the server. A change log on Redis Streams; sign-in with GitHub; cards saved as GitHub Issues; GitHub's
  webhooks for issues, pull requests, checks, workflow runs and deployments; approving and merging change sets on
  GitHub; notes committed to Git; a live feed over WebSocket; and the MCP server agents connect to.
- `web/`: the web app. Home (what the agents are doing, and what waits on you), the Board, Notes (a Markdown editor
  with live preview, [[links]], tables and Mermaid, and Distill), each card full screen, Change sets, Delivery, Agents,
  the Brain and Settings. It works on a phone too.
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
   back), install it on your repos, and sign in with GitHub. Then give your binder its repo, also in Settings → GitHub.
   See [Connect GitHub](#connect-github).

5. **Add an agent**, in Agents, and choose a machine with your code on it: it shows one line to run in the folder with
   your code, on each machine that should take cards. The hub finds the agent tool installed there, makes the agent and starts the
   [runner](#the-runner-agents-that-take-work-on-their-own), which takes cards with Claude Code, Codex or another tool.
   To set an agent up by hand instead, see the runner's section.

Your data is in `/var/lib/binders`: Redis's append-only file, and the hub's own folder with its notes, each Binder's
saved state and note documents, its settings and its secret. Back it up with `/etc/binders/hub.env`; a hub starts from
the saved states even with an empty Redis (see [docs/DEPLOY.md](docs/DEPLOY.md#backups)). To update, `git pull` and run
the same `docker compose … up -d --build`, or let `deploy/update.sh` do it from a timer (it runs the tests first, and
follows whatever is on the branch it's given, so point it at a tag or your fork). To look around first with invented
data, see [demo/](demo/README.md).


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

The hub listens before its Binders have started: `/health` answers at once, and `/ready` answers once they have, with a
503 saying it's still starting until then. Only one hub may use a Redis: a second one started on the same Redis waits a
while for the first to go, then says so and stops.

`deploy/update.sh` keeps a server on the newest commit of its branch: run from a clone by a timer (a systemd timer or cron, every few minutes), it fetches, runs the tests
(`docker build --target test`), and rebuilds only when they pass. Optionally, `deploy/move.sh user@server` moves a hub on a
Mac there, with the hub here stopped: its secret (which seals GitHub's keys), its notes, and its Redis, copied key by
key (`hub/scripts/copy-redis.ts`), so the two Redis versions needn't match. Then add the new address's
`/auth/github/callback` to the GitHub App's callback URLs and point runners at it; the hub points the app's webhook at
itself when it starts.

## Binders on one hub

A hub holds binders. A binder is one notebook, as on the Mac: its folders and notes, its board, its GitHub repo and its
members, at its own address (`https://hub/mobile-app/`). Anyone signed in makes one, from the binder switcher at the top
left, and owns it. Its owners and admins add and remove people in Settings → People, and only they change where its
cards and notes go: its repo, its agents' repos, whether notes are pushed, whether cards are kept as issues, and whether
a Challenge's findings are posted as review comments, along with its GitHub, Jira, folder rules, environments and channel.
Everyone in a binder sees who runs it. The hub's admins run the hub. Being one gives no place in a
binder, so they open the ones they're in and the open ones, like anyone. A binder with no owner (one with no members, or
whose owners have gone) is looked after by the hub's admins until it has one, and they name its first owner. Settings →
This hub → Binders lists every binder on the hub with who owns it, for the hub's admins.
A person in a binder is an owner, an admin, a member or a reader, set in Settings → People. A reader sees everything in it and can ask its brain, and changes nothing: what they try to change is
refused, with a line saying so, and nothing waits on them. Making someone a reader revokes the agents they own there,
and an agent whose owner can only read isn't accepted. A person can leave a binder (Settings → General), unless they're
its only owner; leaving, or being taken out, revokes the agents they own there. The switcher shows how many things wait
in each of the other binders you're in. A binder's owners can take it off the hub by typing its
name: nothing is destroyed, its notes stay in its repo and its data on the hub's disk, and its address stays taken. The
hub's first binder and personal binders can't be taken off. Everyone also gets a binder of their own at `/~login`, which
nobody else opens (the hub's admins included), its notes synced to a private `<login>/binders-notes` repo once the hub's
GitHub App is on their account. Sessions, apps' and agents' tokens and the hub's options are the hub's; an agent's token
belongs to the binder it was made in.

The first binder is the one a hub had before it held several (`HUB_SPACE`, `main` by default, or the one its store already has; named by
`HUB_NAME`). It keeps its folders and starts with no members, so whoever the hub let in still gets in; adding its first
member, as owner, closes it. In Redis each binder is `hub:<address>:…` and the hub's own keys are `hub:_hub:…`. In the
code a binder at its own address is a space, which holds one `binder` (its notes and board) as the log has always
called it; one made before a binder was one notebook may hold several, shown as its parts. A binder goes by its name in
both places: renaming either renames the other.

Each binder keeps **copies** of itself: its notes (with their shared-editing documents), board, change sets, history
and trash in one `.binder-copy.json.gz` file, without its connections to GitHub or Jira, any token, or the pictures and
files in notes. Its owners and admins download one from Settings → General. The hub also writes one a day for a binder
that changed (after 03:00 in its own time) into the binder's `copies` folder, keeping seven, and when a binder's owners
turn on "Keep a daily copy of the whole binder" in Settings → How work flows, pushes them to a `binders-copies` branch of
its repo as one commit. The hub's admins start a new binder from a copy in Settings → This hub → Binders: it gets an
address of its own and starts paused, so it can sit beside the original without writing over it (its notes aren't pushed,
its cards aren't kept as issues, review comments and copies aren't posted or pushed, and its agents are revoked) until its
owners turn those on.

## Working in a binder

**What waits on you.** Home lists what waits on a person in three groups: what's for you, what anyone in the binder
can do, and what waits on someone else. A row is a question an agent asked, a card that stopped, a permission an agent
asked for, a Challenge's findings, a change set to approve, cards Distill proposed, a change suggested to a locked
note, or an environment to promote. The count is in the browser tab's title, and a switch turns on browser
notifications for what starts waiting while the tab is hidden.

**Cards.** A card's title, brief, done-when and size can be changed while it's proposed or ready, or blocked with no
agent on it. What Distill proposes shows on the board in Proposed: it opens in place to read, Accept puts it in Ready,
and Edit first puts it on the board in Proposed, where no agent takes it, to change its words. A ready card no agent
holds can be split into parts, each its own card for the agent it's given, and the card follows once its parts are done.

**When work fails or stalls.** A card whose run fails twice in a row waits in Blocked with why, and any answer puts it
back in Ready. A card whose agent hasn't been heard from for 20 minutes goes back on the board, saying so. A person can
stop a card from the web, which puts it in Proposed, and can send a card in review back to its agent with what to
change. A pull request closed on GitHub without merging comes out of its change set, and its card waits in Proposed.

**Schedules.** A schedule puts a note on the board as a card on a timer, for an agent. Set one from a note's Schedule
button; a schedule can also tell its run to write what it finds as a note in a folder. Settings → How work flows lists
them.

**Folder rules.** A folder can carry a rule: its notes are Distilled once typing in them pauses, or once a run's note is
written, and the rule may accept the cards that come of it, for the agents it names and up to a limit, with no person
in between. Settings → How work flows lists them too. Words heard in a room (a conversation or meeting) always wait
for a person.

**Locks and suggested changes.** A person can lock a note they've settled. Then only they and the binder's owners and
admins can change or move it, whether the change comes from a person or an agent. Anyone else suggests a change, with
why; people and agents can talk it over, and whoever may change the note accepts it or turns it down.

**Telling a channel.** What waits on people reaches them outside the open tab. A binder's owners and admins give it an
address in Settings → How work flows: a Slack incoming webhook, or anything that takes a JSON post. Each thing that
starts waiting is then posted there once, saying what it is and who it's for, with a link. The address is kept sealed and
never shown again, only its host; the hub posts only over https to a public address; and a post that fails is tried again
later without losing what was waiting.

**History and what's deleted.** A binder keeps a history of who did what (Settings → History): notes, cards and folders
deleted, people added, taken out or given another role, where its cards and notes go changed, agents set up or revoked,
change sets approved and environments promoted. It shows the last thousand lines, by person. A deleted note or card
goes to the binder's trash whole and can be put back for 30 days, from the Undo after deleting or from Settings →
History. A deleted card's GitHub issue is closed, saying who deleted it, and opens again if the card is put back.

## Delivery

Delivery follows what GitHub deploys, repo by repo. When GitHub reports a deployment from one of a binder's repos, the
hub makes an environment for it, and each environment shows what's on it, where it's served, the run that put it there,
and which merged pull requests it has, asked of GitHub by commit. The hub shows only what GitHub reports: a merge
doesn't mark anything deployed, and a new hub starts with no environments. A deployment GitHub marks as transient (a preview for one
pull request, say) is passed over, the hub takes at most twelve environments from GitHub in one repo, and a person can
add more by hand. Where webhooks don't arrive the hub looks at GitHub's deployments itself, and **Look on GitHub now**
asks at once.

A binder's owners and admins set what GitHub can't say, in Settings → How work flows: where an environment is served,
its place in its repo's order, and, optionally, a deploy workflow (a workflow file and the branch or tag to run it on).
**Promote** is only for an environment given one: it runs that workflow with the version on the environment before it.
Any other environment only shows what GitHub deploys there. A change set is shipped once its merged pull requests are
on their repos' last environments.

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

Then give each binder its repo, in Settings → GitHub. People sign in to the hub through the app of the Binder whose
address they're at (or the first Binder with one), and connect their GitHub to their other Binders from their account page (their picture, top right).

**Signing in, with a private GitHub App.** A private GitHub App lets only its own organization's members sign in
through it. To let anyone you allow sign in, give the hub a GitHub OAuth App: set `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET` on the hub, with the callback `https://your-hub/auth/github/callback`. It asks
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

Settings → Who gets in has who may sign in and who the admins are, and Settings → Agents how change sets merge and who
agents commit as. They're kept by the hub and take effect at once. Only admins change them; until someone names admins, whoever
can sign in can. An environment variable fixes one (Settings shows it as set on the hub): `HUB_ALLOWED_USERS`,
`HUB_ALLOWED_ORGS`, `HUB_ADMINS`, `MERGE_METHOD`, `HUB_AGENT_COMMITS`.

A few have no switch, as their defaults suit nearly every hub, and only an environment variable changes them:
`HUB_POLL` (following GitHub by asking: `auto` while no webhook arrives, `on`, or `off`), `HUB_POLL_SECONDS` (how often, 30),
`NOTES_QUIET_SECONDS` (the pause before a note is committed, 60), `NOTES_LONGEST_MINUTES` (the longest it waits while typing
goes on, 5), and `HUB_DEV_LOGIN` (signing in by name: `auto` on a hub run on this machine until GitHub is set up, `on`, or
`off`).

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
something is started again on that card with the answer. When a run stops, the card says why in plain words: not signed
in on this machine, out of credit or over its limit, or rate limited for now, each with what to do, and the tool's own
last line. A runner that is stopped on purpose, restarted or updated says so on its cards. When a runner starts, or
reaches the hub again, it gives back any card the hub says its agent holds and it isn't running (left by a runner
that died), unless another runner works as the same agent. A card whose run fails twice in a row isn't taken a third
time: it waits in Blocked with why.

**A machine with your code on it.** **Add an agent** on the Agents page leads with it. It shows one line to run in the
folder with your code, on each machine that should take cards, and says how long it's good for: a day, on as many machines as you like. On macOS or Linux it's
`curl -fsSL https://your-hub/install | sh -s -- join bnj_…`, and on Windows the PowerShell form the page shows.
`binders join` looks at the machine: which agent tools are installed (Claude Code, Codex and the others the Agents page
lists) and which GitHub repos the folder holds. The hub chooses the tool and makes the agent, named for the tool and the
machine, and the runner starts in the background, as below. Each machine shows on the page as it joins and starts
listening. The same machine running the line again is the same agent, with a fresh token. With no agent tool on the
machine, it says which it looked for: install one and run the line again. A hub admin's line also lends the machine's
models to the hub's brain (see [The brain](#the-brain)).

**By hand.** For a tool or a name the hub wouldn't have chosen, **Add an agent** on the Agents page, then **Set one up by
hand**, makes an agent with a token, shown once. To run it in a terminal on the machine where the code is:

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

To keep an agent set up by hand running in the background instead, the hub's installer sets up the `binders` command and
the agent in one line (the Agents page's Start the runner gives it with the token filled in). An agent added with a
machine's line runs this way too:

```bash
curl -fsSL https://your-hub/install | sh -s -- add --token bnd_… --workspace ~/code/my-repo
binders list            # every agent on this machine: running or not, its process, uptime, last log, folder
binders logs NAME -f    # what it's doing
binders restart NAME    # also stop, start, remove; --all for every one
```

The installer asks for Node 22 or newer, as an agent's terminal links to the hub with Node's own WebSocket; on an older
Node, cards still work, and the runner says once that terminals need 22.

Each runs as a service of yours (a LaunchAgent on a Mac, a `systemd --user` unit on Linux, a logon task on Windows,
which needs no admin rights: install it with `& ([scriptblock]::Create((irm <hub>/install.ps1))) add --token bnd_… --workspace C:\code\app`
in PowerShell. Runs kept going through restarts and an agent's own terminals aren't on Windows yet): it starts at login and
again after a crash, logs to `~/.binders/logs`, and keeps its token in `~/.binders/agents`, readable by you alone. On a
Mac, an agent working in `~/Documents` needs node allowed there once (macOS asks), and its tools' sign-ins (Claude Code,
Codex) done beforehand, as a background service can't show them.

Run as the file the hub hands out (`binders-runner.mjs`), the runner keeps itself current: when the hub has a newer
one and it's idle, it replaces its file and starts again on it, without being restarted by hand.

On a network that signs HTTPS itself or needs a proxy, there's nothing to set for certificates: the runner reads this
machine's certificate store (with Node 23.9 or newer; before that, set `NODE_EXTRA_CA_CERTS`). Have `HTTPS_PROXY` and
`NO_PROXY` set in the shell you run `binders add` from, and the service keeps them, along with `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE` and `SSL_CERT_DIR`, in a file only you can read. Following a proxy takes Node 24 or newer. If it can't
get through, `binders logs NAME` says why, with the cause and what to try.

An agent that says nothing for 15 minutes (`--idle-minutes`, or its settings) is stopped as stuck, and its card,
debrief or Challenge says so: a model it can't reach, a prompt waiting in its own app, a login gone stale. A laptop that slept isn't taken for an agent gone quiet. Each runner also tells the hub who it is,
so a second runner for the same agent hears of the first when it starts, and the Agents page says when more than one
is running: they'd take the same work.

A binder can name the repos its agents work in, in Settings → GitHub; each agent then works in all of them, or the ones
it's limited to among them. Picking a repo searches the hub's own list of what its GitHub App reaches, read in the
background and kept in Redis, so an organization with tens of thousands of repos is searched as you type: by name, by
what's in their description, or by their GitHub topics and an organization's custom properties. A binder or an agent
can take every match of a filter at once (200 at most): each is checked with GitHub first, and any you can't push to or
that's archived is left out, with why. A filter picks repos now, and doesn't follow them: a repo that gets the topic
later isn't added.

Custom properties come with the app's list of repos when GitHub gives them there; when it doesn't, the hub reads the
organization's own list of them, which takes the app's Custom properties (read) organization permission. Settings →
GitHub says which it is for each organization, and where to give the permission.

The people suggested as you type a GitHub name (who may sign in, admins, a binder's members) come from the same kind
of list: each organization's members, read in the background, kept, and read again every two hours, so one of thousands
is found as you type. An app made from now on also hears people join and leave as it happens.

An agent reaches no more of GitHub than the person who set it up. It takes a card only in a repo its owner can push to,
as GitHub says with the owner's own sign-in (refused otherwise, with why, and not offered again for a while), and each
run gets a token of the GitHub App's for that one repo, for an hour, to read and push code and open pull requests
(`repo_token`; the runner renews it on long runs). The runner hands it to the agent's git through a credential helper,
with SSH addresses of that GitHub sent over HTTPS, and to gh as `GH_TOKEN`, so the machine's own GitHub login isn't
used. If the hub refuses a token for a card, the run doesn't start, and the card goes back with the hub's words. A hub
without a GitHub App (a token set by hand) can't narrow a token: there the agent uses the machine's login, and the
runner's log says so.

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
so. (A live terminal goes through the `binders` command instead, which needs no MCP server.) To give it Binders' tools back, an admin adds the hub to the managed config:

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

### DeepSeek Harness, for your own models

The runner can start agents with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2.1 or newer (`npm install -g @deepseek-ai/dsh@latest`): choose it as the agent's tool on the Agents page. It reaches Azure OpenAI, OpenAI-compatible gateways and self-hosted servers through its own settings, in `$DSH_HOME/profiles/headless/cordis.patch.yml`, with keys read from the environment or `$DSH_HOME/.env`:

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        api: openai-completions
        baseURL: https://gateway.example.com/v1
        apiKeyEnv: MY_GATEWAY_KEY
        models:
          - id: my-model
            contextWindow: 200000
```

Name the agent's model as `provider/model` (`my-gateway/my-model`, or `azure/my-deployment` with `AZURE_OPENAI_*` set). Each run adds Binders' MCP server with the agent's token from the environment, never in a file, and turns off Harness's session-log and telemetry uploads. Runs use full access: its released versions can't grant a worktree the git folder its commits go in. It has no terminal app, so these agents have no Terminal button. Harness is in developer preview, so an upgrade of it can break this.

### What an agent may do without asking

A run has nobody to approve a step, so Claude Code refuses whatever it would ask about. The runner gives it what the
person's own sessions have: each card's worktree (and each review's or brief's checkout) gets a copy of the repo's
`.claude/settings.local.json` (the "don't ask again" answers, kept out of git), and runs may read the runner's whole
workspace (`--add-dir`), other repos included. Each agent's "Commands it may run" on the Agents page adds Claude Code
permission rules of its own (`Bash(git:*)`, `WebFetch(domain:github.com)`; "Add the usual for coding" fills in the
common ones). Where a machine's policy turns full access off, which the runner sees in Claude Code's managed settings or
in the mode Claude Code starts in, runs accept edits instead, and the commands they run follow the policy's rules. What
Claude Code refused a run is listed on the card; a card that needed it, or whose agent asked a person, waits in Blocked.

## Jira

A binder can mirror its cards into one Jira Cloud project: **Settings → Jira** names the address, a service account and token, the project and issue type, and the status each stage stands for. Saving brings in the cards still going; ones already done stay out. A card becomes an issue with its brief and done-when as the description, and its stage becomes the issue's status where the project's workflow allows it. A Jira webhook (the address Settings shows) brings back what people do there: a status they change moves the card by the board's own rules, so only an agent starts work, and a comment lands on the card. The hub keeps the words: a description edited in Jira isn't read back.

## Connect an agent

To have agents take cards, add a machine in **Agents** (see [the runner](#the-runner-agents-that-take-work-on-their-own)). To connect an agent you
run yourself, choose **Add an agent**, then **Set one up by hand**, there: it gets a token, shown once, and the settings to paste into Claude
Code, Codex, Claude Desktop or any MCP client. The agent then calls `whoami`, `wait_for_work`, `claim_task`, `report_progress`, `ask` and `complete_task` (the
MCP server's instructions say how).

To try it without a real agent: `cd hub && HUB_URL=http://localhost:5173 BINDERS_TOKEN=bnd_… npm run stand-in`.

## Connect your terminal, as yourself

An agent's token is for a runner, which has no browser. A person's terminal (Claude Code, Cursor or another MCP client)
connects as the person instead, through OAuth, so there's no one-time pad to copy and replacing an agent's token doesn't
break it. One address serves every binder. **Add an agent** on the Agents page, then **Use this hub from Claude Code** (or
“Add the hub to Claude Code” in ⌘K, or **Connect a client** on your account page), gives the command with the hub's address in it:

```sh
claude mcp add --transport http --scope user binders-hub https://your-hub/mcp
```

It's `binders-hub` because Binders for Mac gives its own server the name `binders`, and a runner gives the one it adds
for an agent's run `binders_hub`. In Claude Code, `/mcp` signs it in: a browser opens; sign in with GitHub, tick the
binders it may work in, and allow it. It gets a person token
that runs out and renews itself, and the connection shows under **Your account → MCP connections**, with its binders,
where it can be stopped. To change which binders it reaches, connect it again. A binder's own address
(`https://your-hub/<binder>/mcp`, in **Settings → Status**) connects to that binder alone.

Each binder stays apart: every call works in one of them, named by its id from `list_binders`, or found by where the
card, note or change set it names is; notes don't move between them, cards wait only for cards of their own binder, and
an agent is given only cards of its own. The connection loses a binder as soon as you leave it or are taken out of it, and the token isn't
accepted on `/api`. A client that can’t sign in with OAuth can be given a person token on the account page (**Create a
token**), for the binder it's made in, to put in its config as a Bearer token; it lasts until it’s stopped. A
connection can read and write notes, make and comment on cards, assign them, and read change sets, debriefs and
Challenges, ask the brain a question and put captures in (`ask`, `capture`; with no binder named, a capture goes where
the person chose their captures to go); taking work and finishing it stays with agents. In a binder they can only read,
a connection reads and asks, and writes nothing.

The hub is the OAuth server for this: MCP clients discover it from a 401, register themselves, and exchange a code with
PKCE (`/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, and the `.well-known` metadata). GitHub is
only the identity provider, through the hub's OAuth App or a binder's GitHub App. `/mcp` still takes an agent's `bnd_…`
token for runners; a person's `bnp_…` token is accepted there and at the address of any binder it was allowed.

## The brain

The hub can sum up what your phone and Mac capture, and answer questions from your binders. **Settings → Brain** (an
admin's) picks its model: Claude, with the hub's Anthropic key, or a server of your own that speaks OpenAI's API (Ollama,
LM Studio, vLLM), which keeps the words on your machines. An embeddings model is optional: with one, passages are found
by what they mean as well as by their words.

- **Captures.** A phone or Mac sends a dictation, a conversation it heard or a meeting, as words, to
  `POST /api/captures` with its app token. Each becomes a note in a binder's Dictations, Captures or Meetings folder:
  the binder its person chose for their captures on Your account (their own unless they say), unless the capture names
  one. A conversation or meeting gets a summary at the top when the hub has a model: what it was about, what was decided,
  who said they'd do what. One that arrived while no model answered gets its summary once one does, without writing over
  what anyone added since. Any note with enough in it can be summed up from its menu. The folder's rules then apply, so
  a folder that Distills turns it into cards. A follow-up the iPhone offers and a person accepts there is a card in
  Proposed, with its note, its words and a brief. Sent again with the same `sourceId`, a capture gives back the note it
  made the first time. A folder of captures shows the newest first.
- **Sending a note.** A note's menu has Send to…, for another binder you're in: a copy goes there with its pictures, each
  saying where the other is. That's how what a phone heard reaches a team's binder.
- **Audio.** With a transcription model (any server that speaks OpenAI's transcription API: whisper.cpp,
  faster-whisper, a Parakeet server, OpenAI), the iPhone sends a conversation's audio to `POST /api/app/audio` and the
  hub writes it down with a bigger model than a phone can run, keeping the names of the voices the phone told apart. When
  the phone's own transcript got there first, the hub's goes in its place and the summary is written again. The audio
  isn't kept.
- **Speech.** With a speech model (OpenAI's speech API: Kokoro, a Piper gateway, OpenAI), `POST /api/brain/speak` and the
  iPhone's `binders/speak` read answers out.
- **Local AI only.** A switch that keeps every model on the hub's own network (this machine, private ranges, VPN ranges
  such as 100.64/10, `.local` and one-word names): Claude, a gateway's cloud models and any outside address are
  refused.
- **Your machines.** Any of those jobs can be served by a machine of yours: a Mac, or a GPU box such as a DGX Spark.
  - **Adding them.** In Settings → Brain, an admin clicks Add your machines and gets one line:
    `curl -fsSL <hub>/install | sh -s -- add --token bnj_…`. It works on any number of machines for 24 hours.
  - **Running the line.** Each machine joins under its host's name, with a token of its own, and the Binders daemon
    starts there in the background: launchd on a Mac, systemd on Linux, Node 22 or newer. Running the line again on
    the same machine refreshes it.
  - **What the daemon serves.** It finds the model servers on its machine: every port the machine listens on that
    answers OpenAI's model list (at `/v1/models` or `/models`), so Ollama, LM Studio, vLLM or NIM, TensorFold, MLX,
    whisper or Parakeet and Kokoro are found wherever they listen. `--serve` covers anything else. A server that wants
    a key is reported as such. The daemon updates itself when the hub has a newer one, as an agent's runner does. On a Mac it also finds macOS's voices. It says what it found and
    makes the requests the hub sends, to those servers only, so the hub can't reach anything else through it.
  - **What the hub picks.** For each job no one set, the hub picks the best model on your machines: the biggest chat
    model, an embeddings model, Parakeet, Canary or the largest whisper, and a speech server's voice, else a Mac's
    own. When a better one appears later, it takes over. A job an admin set, even to off, stays theirs until they hand
    it back.
  - **A gateway to a cloud.** A server on a machine that lists cloud models (a proxy to Azure, OpenAI or Anthropic,
    such as LiteLLM) is a gateway: what's asked of its models leaves your network, so the hub never picks one itself.
    An admin can: under the hub's model or Finding by meaning, the gateway's models are listed to find by name and
    choose, every one it lists up to two thousand. A name it doesn't list, such as a deployment's, can be typed and
    tried the same way. The one chosen is asked one short thing first, through the machine, and the job stays as it
    was when nothing comes back, with what the gateway said.
  - **Every model downloaded on the machine, served when asked for**, as Ollama serves its own. The daemon offers the
    hub one more server per machine: every downloaded model an engine there can run, and that fits its memory. When a
    request names one, the daemon starts its engine and passes the request on:
    - TensorFold, if it's installed, for chat models: one model a process, on a Mac (MLX) and on Linux with an NVIDIA GPU.
    - mlx-lm on a Mac for chat models: one process, loading the model each request names. Installed with uv.
    - mlx-audio on a Mac for speech and transcription models, the same way. Installed with uv, with its server's packages.
    - vLLM on Linux, when it's installed and TensorFold isn't.

    It runs one big model at a time and, on Linux, only when there's the free memory for it. It stops what it started
    after twenty idle minutes and never touches a server you started. Each engine's output is in
    `~/.binders/logs/<engine>.log`. Settings shows, for each machine, how many models it loads when asked, what's
    running, and why the rest can't run there (made for NVIDIA GPUs, too big, GGUF, speech on Linux…).
  - **Models already downloaded.** The daemon also sees models that nothing serves yet:
    - Hugging Face's, by the names of its model folders only. It looks in the cache your shell set (`HF_HOME` and
      `HF_HUB_CACHE`, which the service keeps) and the usual one. It never opens a file there or reads the token.
    - Folders of models in `~/models` and `/models`, also by name.
    - LM Studio's, from `lms ls`.

    It says which it found, and where it looked, both in `binders add` and in Settings.

    When one would do better than what's in use (Kokoro over a Mac's own voices), Settings offers "Use it". That starts mlx-audio for audio on a Mac (through
    `uv`, so nothing needs installing), or LM Studio's server. The daemon starts it again whenever it restarts.
  - **Downloads.** For a job none of your machines can do, Settings offers one click to download a model into Ollama on
    a machine that has it. The model is sized to that machine: a chat model by its memory (`gpt-oss:120b` on a
    128 GB Spark), `embeddinggemma`, `lfm3-audio:2b` for writing down and reading out, and `phonon:en` for a Mac's
    voice. On a Mac with mlx-audio, audio comes from Hugging Face instead: Parakeet v3 and Kokoro. Progress shows as it goes, and the job uses the model once it's there. The daemon only ever pulls a
    model's name through Ollama's own API. A transcript with no times never replaces the iPhone's timed one.
- **The Brain.** The **Brain** screen, `POST /api/brain/ask` and the MCP tool `ask` answer a question from the notes and cards of
  a binder, or every binder you're in, numbering the ones the answer rests on. Without a model, they give the passages
  that match best. The Brain follows a conversation: a question is answered knowing what came before it, and the hub keeps a
  person's conversation (their last 20 questions), so it's there on opening the Brain again or on another device, until they
  start a new one.
- **A note's Chat.** When no agent is listening, a note's Chat answers from the hub's own model, with the note in front
  of it and the rest of the binder to draw on. It reads the note and can't change it, and says an agent can.
- **Search.** ⌘K finds notes and cards by title at once, and passages by their words and what they mean when typing pauses (`POST /api/brain/search`). Its "Ask the Brain" row takes what you typed to the Brain for a cited answer, and comes first when it reads as a question.
- **Embeddings.** Notes and cards are cut into passages, and each goes to the embeddings model once its edits pause. Redis holds a working copy. The vectors are also written to the hub's disk, one file per note or card (a hash of each passage and its vector, none of its words), and pushed to the `binders-embeddings` branch of the binder's repo, which keeps no history. A binder with no repo, or with saving notes to it turned off, keeps them on the disk alone. A hub with an empty Redis takes vectors from these files before asking the model, and one with an empty disk fetches them back from the repo.
- **Each binder's own.** A binder's index is kept in its own store, and a question reaches only the binders you're in.
  A personal binder's passages never go to the embeddings server. What a conversation or meeting turns into waits for
  a person, even in a folder whose rule accepts work on its own: words heard in a room are nobody's own.
- **Keys.** They're sealed, like GitHub's, and go only where they were meant to: a key saved in Settings is cleared when
  the provider changes, and one set in the environment goes only to an address the environment sets too. `BRAIN_PROVIDER` (anthropic, openai or off), `BRAIN_MODEL`, `BRAIN_BASE_URL`,
  `BRAIN_API_KEY` (or `ANTHROPIC_API_KEY`), `BRAIN_SUMMARIZE`, `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`,
  `EMBEDDINGS_API_KEY`, `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL`, `TRANSCRIPTION_API_KEY`, `SPEECH_BASE_URL`,
  `SPEECH_MODEL`, `SPEECH_VOICE`, `SPEECH_API_KEY` and `BRAIN_LOCAL_ONLY` set it on the hub instead, and Settings shows
  what they fix.

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
admins can still rename it, point it elsewhere or revoke it. Taking its owner out of a binder revokes it there, and an
agent whose owner is no longer in its binder is refused.

## License

Copyright (C) 2026 Binders. [AGPL-3.0](LICENSE). You may run, change and share Binders Hub; if you run a changed version for others over a
network, offer them its source (section 13).
