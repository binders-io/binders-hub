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
debrief or Challenge says so: a model it can't reach, a prompt waiting in its own app, a login gone stale. Each runner
also tells the hub who it is, so a second runner for the same agent hears of the first when it starts, and the
Agents page says when more than one is running: they'd take the same work.

A binder can name the repos its agents work in, in Settings; each agent then works in all of them, or the ones it's
limited to among them. Picking a repo searches the hub's own list of what its GitHub App reaches, read in the background
and kept in Redis, so an organization with tens of thousands of repos is searched as you type.

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

In **Agents**, set one up: it gets a token, shown once, and the settings to paste into Claude Code, Codex, Claude
Desktop or any MCP client. The agent then calls `whoami`, `wait_for_work`, `claim_task`, `report_progress`, `ask` and
`complete_task` (the MCP server's instructions say how).

To try it without a real agent: `cd hub && HUB_URL=http://localhost:5173 BINDERS_TOKEN=bnd_… npm run stand-in`.

## Connect your terminal, as yourself

An agent's token is for a runner, which has no browser. A person's terminal (Claude Code, Cursor or another MCP client)
connects as the person instead, through OAuth, so there's no one-time pad to copy and replacing an agent's token doesn't
break it. One address serves every binder. **Add to Claude Code**, at the top of the hub (or in ⌘K), gives the command
with the hub's address in it:

```sh
claude mcp add --transport http --scope user binders-hub https://your-hub/mcp
```

It's `binders-hub` because Binders for Mac gives its own server the name `binders`, and a runner gives the one it adds
for an agent's run `binders_hub`. In Claude Code, `/mcp` signs it in: a browser opens; sign in with GitHub, tick the
binders it may work in, and allow it. It gets a person token
that runs out and renews itself, and the connection shows under **Your account → MCP connections**, with its binders,
where it can be stopped. To change which binders it reaches, connect it again. A binder's own address
(`https://your-hub/<binder>/mcp`, in its **Settings → Agents**) connects to that binder alone.

Each binder stays apart: every call works in one of them, named by its id from `list_binders`, or found by where the
card, note or change set it names is; notes don't move between them, cards wait only for cards of their own binder, and
an agent is given only cards of its own. The connection loses a binder as soon as you leave it, and the token isn't
accepted on `/api`. A client that can’t sign in with OAuth can be given a person token on the account page (**Create a
token**), for the binder it's made in, to put in its config as a Bearer token; it lasts until it’s stopped. A
connection can read and write notes, make and comment on cards, assign them, and read change sets, debriefs and
Challenges, ask the brain a question and put captures in (`ask`, `capture`); taking work and finishing it stays with
agents.

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
  `POST /api/captures` with its app token. Each becomes a note in its binder's Dictations, Captures or Meetings folder.
  A conversation or meeting gets a summary at the top when the hub has a model: what it was about, what was decided,
  who said they'd do what. The folder's rules then apply, so a folder that Distills turns it into cards. Sent again with
  the same `sourceId`, it gives back the note it made the first time.
- **Audio.** With a transcription model (any server that speaks OpenAI's transcription API: whisper.cpp,
  faster-whisper, a Parakeet server, OpenAI), the iPhone sends a conversation's audio to `POST /api/app/audio` and the
  hub writes it down with a bigger model than a phone can run, keeping the names of the voices the phone told apart. When
  the phone's own transcript got there first, the hub's goes in its place and the summary is written again. The audio
  isn't kept.
- **Speech.** With a speech model (OpenAI's speech API: Kokoro, a Piper gateway, OpenAI), `POST /api/brain/speak` and the
  iPhone's `binders/speak` read answers out.
- **Local AI only.** A switch that keeps every model on the hub's own network (this machine, private ranges, VPN ranges
  such as 100.64/10, `.local` and one-word names): Claude and any outside address are refused.
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
- **Ask.** The **Ask** screen, `POST /api/brain/ask` and the MCP tool `ask` answer a question from the notes and cards of
  a binder, or every binder you're in, numbering the ones the answer rests on. Without a model, they give the passages
  that match best.
- **Search.** ⌘K finds notes and cards by title at once, and passages by their words and what they mean when typing pauses (`POST /api/brain/search`). Its Ask row takes what you typed to the Ask screen for a cited answer, and comes first when it reads as a question.
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
admins can still rename it, point it elsewhere or revoke it.

## License

Copyright (C) 2026 Binders. [AGPL-3.0](LICENSE). You may run, change and share Binders Hub; if you run a changed version for others over a
network, offer them its source (section 13).
