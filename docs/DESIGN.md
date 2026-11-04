# Binders Hub: design

Status (2026-10-30): built end to end. Notes, binders, cards, agents, pull requests, change sets and environments all
live in the hub's change log; people sign in with GitHub; agents work over MCP; GitHub keeps cards as issues and
reports back through webhooks. A fresh hub starts with one binder and a welcome note.

## What it is

One pipeline from a line in a note to production, for people and agents together:

1. **Note.** Written and edited together, live.
2. **Distill.** An agent reads the note and proposes work items. Nothing reaches the board until someone accepts it.
3. **Work items.** Agents claim them, work, report progress and ask questions.
4. **Pull requests.** Each item gets a branch and a pull request, opened through the Binders GitHub App, so agents
   never push to the default branch.
5. **Change sets.** Pull requests that belong together, across repos, are reviewed and approved as one, then merged in
   the order their items wait for.
6. **CI.** Checks show live on every pull request. A failed check goes back to the agent that owns it.
7. **CD.** Each environment shows what's in it. Promotion that needs approval is approved from the app.

Every step links back: a line in a note shows the card, the pull request, the change set and where it's deployed.

## Where things are kept

The hub keeps no data of its own. Redis holds what's being worked on now, and each kind of thing is kept in the tool
the team already uses. GitHub first, with Jira and Confluence as the next adapters.

| What | GitHub (first) | Next |
|---|---|---|
| Work items | Issues, sub-issues and their blocked-by links, a Projects field for the column | Jira |
| Notes | Markdown files in a repo, one commit per batch of edits | Confluence |
| Pull requests, CI, CD | Pull requests, check runs, workflow runs, Deployments and Environments | GitHub stays, for Jira teams too |
| Change sets | A tracking issue labelled `change-set` that lists its pull requests in merge order | |
| Agents | The hub's registry, in Redis | |

Three boundaries from day one, so Jira is one more adapter: **WorkItems**, **Notes** and **CodeHost**. Each adapter
reads, writes, watches (webhooks or polling) and maps fields, and keeps the outside id and version.

Fields the outside tool has no place for (the agent, waits-for, approvals, the note a card came from) go in the outside
tool itself: a hidden block at the end of the issue body, Jira custom fields, Confluence page properties. If Binders
is switched off, everything is still in GitHub or Jira.

What you can see comes from the outside tool: the hub acts with each person's own token, so a repo you can't see is
a board you can't see.

## The hub

- **Change log.** Every write appends to a Redis Stream per binder with a version, and goes out live over WebSocket.
  A client that reconnects asks for everything after the version it had.
- **Savers.** One consumer group per destination reads the log and writes to it, combining edits first (a note being
  typed is one commit when the typing pauses, not one per keystroke). A change stays on the log until the destination
  confirms it, so an outage is a queue.
- **Webhooks in.** Issues, pull requests, reviews, checks, workflow runs and deployments become changes on the log.
  Events the hub caused itself are dropped.
- **Agents.** Remote MCP over HTTP with OAuth. An agent registers with its name, repos and skills; presence comes from
  a heartbeat. Work goes out through a consumer group, one agent per card, and a card an agent went quiet on comes
  back after ten minutes (`XAUTOCLAIM`).
- **Redis durability.** Disk persistence on, and the log is the only copy of a change until its destination confirms it.

## Binders for Mac

The Mac is one more client: a binder marked as synced is mirrored both ways through the same API the web app uses.
The Mac can also register as a worker for what needs a machine: transcription and Distill on local models, and Claude
Code runs in a repo.

## Notes through the hub (built)

- Each change (`note.edit`, `note.move`, `folder.put`…) goes into the log with the next version, by a Lua script that
  numbers it and drops a client's resend of the same id. The stream id is the version, so catching up is a range read.
- Every hub applies the log in order with the same `apply` the web app uses (`shared/notes.ts`), so two hubs on one
  Redis, and every client, end up with the same notes.
- A browser shows the hub's notes with its own waiting changes on top. Waiting changes are kept per tab in the browser,
  so an edit made offline goes when the hub is back, and a teammate's change arriving first never loses yours.
- The Git saver writes `binder/folder/title.md` with Binders' fields in front matter, commits when a note's edits pause
  for 1.5 s, moves the file when the note moves or is renamed, and records `note.saved` with the commit. A note's history
  and any old version come from Git (`/api/notes/:id/history`, `/api/notes/:id/at/:sha`).
- Two people in the same note both keep their words: the hub keeps an Automerge document per note
  (`shared/noteDoc.ts`, laid out as Binders for Mac's NoteDocument: `text` and `props`). A `note.edit` carries Automerge
  changes (`changes`, base64); the hub checks they build on what it has, applies them in log order, and sends the edit
  on with the note's text and title as merged, so a client without a document shows the same. An editor starts from
  `GET /api/notes/:id/doc` and keeps it in step with the edits' changes from the live feed.
- A note's document starts from its text when it's first needed: a skeleton and then the text, both made under the
  note's own actor at time 0, so every hub and client makes the same two changes from the same id and text. Notes
  written before Automerge start that way from their current text. An edit sent as the whole text (MCP's `edit_note`
  and `append_to_note`, a web app from before) becomes the changes that take the note there before it goes in the log;
  a note put again whole starts its document over.

## Notes in the web app (built)

Notes are Markdown, as in Binders for Mac and Obsidian, edited in CodeMirror 6 with live preview: the markup shows only
on the lines being edited (or everywhere with Show Markdown).
- GitHub's Markdown: headings, bold, italic, strikethrough, code, links, pictures, quotes, lists, checklists you click,
  dividers, tables drawn as a grid, fenced code with highlighting, and Obsidian callouts (`> [!note]`).
- `[[Links]]` between notes, with `|alias` and `#heading`; typing `[[` suggests notes, and a link to a note that isn't
  there yet makes it. Linked mentions under each note.
- ```` ```mermaid ```` blocks drawn as diagrams while the caret is elsewhere, in the theme's black and white.
- A slash menu (as on the Mac: headings, checklist, lists, quote, callout, code, table, diagram, divider, picture, link
  to a note, date, time), a formatting toolbar, and the Mac's keys (⌘B, ⌘I, ⌥⌘1…).
- Work from the note shows at its words: a card's number and stage, or Distill's Proposed.
- The editor edits the note's Automerge document (`web/src/data/liveNote.ts`): it starts from
  `GET /api/notes/:id/doc` with the tab's waiting changes on top (a note made in the tab and not yet on the hub starts
  as the hub will), what you type becomes changes sent in `note.edit`, and teammates' changes from the live feed come
  into the editor as edits where they were made, so your caret stays and your undo is only yours. Until the document is
  here (offline), what you type goes as the whole text and the document is taken once that has gone. After a missed
  feed the hub's document is merged in; after a refusal it's taken again.

## A story, full screen (built)

Opening a card shows its whole way from the note to production: a rail of every step (written, distilled, on the
board, claimed, built, pull request, checks, approved, merged, staging, production) with where it is now, the agent's
plan, every step it took (files read, edits, commands and what came back), the session, the pull request's changes,
and beside it the brief, the note's words, what it waits for and holds up, its checks, its change set, where it's
deployed, and its activity.

## The web app

- Every interaction under 100 ms: the client keeps a local copy and applies changes before the server answers.
- Keyboard first: ⌘K for everything, number keys for the screens.
- A phone is a full client. A tab bar for the main screens, the sidebar as a menu, the board a column a screen with a
  row of stages over it, and 44px to press wherever there's a touchscreen (a mouse keeps the denser sizes). Nothing
  needs a hover, a right-click or a drag: what's on a right-click is on a ⋯ too, and what's moved by dragging can be
  moved from that menu.
- Anyone can follow along on a keyboard or a screen reader. Focus goes into what opens, stays there and comes back
  (`useModal`), going to another screen moves it to the heading and names the tab, and a control is never inside
  another. axe runs over every screen in `web/test/a11y.test.tsx`, beside a check of every text tone on every surface.
- Motion that shows what happened: a card travels when an agent takes it, a check fills in as it runs.
- The board can set aside what Distill proposed and nobody has accepted or dismissed yet, and each browser remembers
  that. It only leaves the board: Home, the nav and the notes list still count it, and its note still shows it.
- White on black, or ink on a cool paper, following the system unless you pick one. Colour for state: green done, blue
  running, amber waiting on you, violet in review, red failed. Light mode is layered (a tinted canvas, a deeper sidebar,
  white cards and tiles with a soft shadow) and adds an indigo accent for primary buttons and progress. In both, every
  text tone keeps 4.5:1 on each of its surfaces. Nunito for headings, Nunito Sans for text.
- Notes: binders and folders as a tree (each folder a folder in the notes repo), a block editor that saves as Markdown,
  one commit when the typing pauses, and a note's path in the repo shown under its title.

Stack: TypeScript end to end. React and Vite for the web app; Node or Bun for the hub, with MCP's TypeScript SDK.
Hosting: Docker Compose (hub and Redis) for self-hosting first.

## First slice

GitHub only: the change log, the Issues saver, webhooks in, remote MCP for agents, the web board, and one binder synced
with the Mac.

## Risks

- GitHub's rate limits (about 5,000 calls an hour per user): combine writes, lean on webhooks.
- Webhooks need a public address; self-hosted Jira may need polling.
- Confluence stores pages as XHTML, so Markdown doesn't round-trip cleanly. A Git repo is cleaner for notes.
- A note edited live in Binders and in Confluence at once needs the outside edit merged in.

## Agents (built)

- A person sets an agent up in Agents: name, tool, repos, binders, skills. The hub gives a token (`bnd_…`), shown once;
  only its hash is kept. A new token replaces the old; revoking stops it at once and puts what it held back on the board.
- The agent connects to `/mcp` (Streamable HTTP, stateless, Bearer token). Its tools: `whoami`, `update_profile`,
  `list_binders`, `list_notes`, `get_note`, `create_note`, `append_to_note`, `list_tasks`, `get_task`, `wait_for_work`
  (waits up to 50 s for a card it could take), `claim_task`, `report_progress` (doing, progress, plan, steps, said),
  `ask`, `comment_task`, `release_task`, `complete_task` (with a pull request or without), `create_task`,
  `propose_work_items` (Distill: quotes must be the note's words, and repeats are left out), `report_diff` (for a
  runner: its worktree's diff), `get_change_set`, `send_debrief` and `get_debrief` (a card's debrief), and
  `get_challenge_set`, `send_challenge` and `get_challenge` (a card's Challenge), and `reply_to_findings` (the author's
  one round of replies to its findings).
- A claim is a change in the log, so when two agents claim at once the first one applied gets it.
- A card's Change Set (`shared/changeSet.ts`, `GET /api/cards/:id/change-set`) gathers what its work proposes: the pull
  request's diff, or before there is one, the diff of the card's worktree that its runner sends every minute and when
  the agent stops (against where the branch left the workspace, uncommitted and new files too, cut to 200 files and
  4,000 lines); its brief, done-when and the note's words; and the agent's plan and log. Debrief and Challenge build on it.
  A pull request whose files haven't come from GitHub yet doesn't hide the worktree's diff.
- **Debrief** (`POST /api/cards/:id/debrief`): a button on a card in In progress or In review, on the board beside its
  pull request, on its full screen beside the pull request link, and on the Change sets screen. The hub gives it to the
  agent named, or else one listening and free (the card's own first), as `wait_for_work` kind `debrief` to runners that
  say `debriefs: true`. The agent reads `get_change_set` (its done-when split into points: a line each, or a sentence
  each) and sends `send_debrief` with five sections: what it does; what changed, by area; each done-when point marked
  met, partly met or not met, with where; things to look at; how to try it. The hub refuses one missing a section or a
  point. It's kept on the card (`card.debrief`, in the log, so it's there after the hub restarts and in every browser
  at once) and shown on its full screen, which fits a phone; asked again, the last one shows until the new one is
  written. Once written it's also kept on GitHub, as a comment on the card's issue (not in its body) that's edited in
  place each time it's written again, so it's there with Binders off and in GitHub's iPhone app.
- A debrief is **speakable**: `debriefSpeech` (`shared/changeSet.ts`) turns it into plain sentences in the order you'd
  want to hear them (what it does, how it stands against the done-when, what to look at, what changed, how to try it).
  Read aloud on the card says it in the browser's voice, on a phone too; agents, such as the talk-to-myself loop, get
  it with `get_debrief` (its sections and `speech`), and `GET /api/cards/:id/debrief` gives the same. A runner whose agent has no Binders tools gives it the Change Set
  in its prompt and sends the JSON it writes to a file.
- **Challenge** (`POST /api/cards/:id/challenge`): a button beside Debrief, on a card in In progress or In review that
  has a diff. It's an adversarial review by an agent that didn't write the work: never the card's holder, its pull
  request's agent, or any agent that worked it before (`authorsOf`). On the card's full screen a person picks the
  reviewer, or the hub picks: listening and free first, and one that didn't write the debrief (it read the log) before
  one that did. It goes out as `wait_for_work` kind `challenge` to runners that say `challenges: true`.
- The reviewer gets `get_challenge_set`: the diff with each line numbered as in its file (diff lines keep `n`, read from
  the hunk headers), the pull request and its checks, the brief, the done-when points and the note's words. It never
  gets the author's plan, progress log, conversation, `doing`, or the debrief: while its Challenge is open, `get_task`
  leaves them out, and `get_change_set` and `get_debrief` refuse. The runner gives it a checkout of its own (the pull
  request's head, fetched, or a snapshot of the author's worktree made with a separate index), not the author's folder,
  so nothing kept beside that folder (an agent's memory of it, its sessions) comes along, and starts it with no session.
- It sends `send_challenge`: a summary and findings, each with its kind (bug, done-when, security, edge case, breaks,
  simpler), file and line, what goes wrong, confidence (confirmed or plausible), severity (high, medium, low) and a fix
  if it sees one. The hub refuses a finding missing any of them. Kept on the card (`card.challenge`, worst first, ids
  `f1`…) and shown under the debrief, with each file:line linking to GitHub; asked again, the last findings show until
  the new ones come. It isn't written into the card's issue.
- **Replies** (`POST /api/cards/:id/challenge/replies`): under a done Challenge with findings, a person may ask the
  author (the card's holder, else its pull request's agent, else its first author) to reply. It goes out as
  `wait_for_work` kind `replies` to runners that say `replies: true`; the runner starts the author in the card's own
  worktree, carrying on its session for the card, and it answers every finding at once with `reply_to_findings`:
  `fixed` (it fixed it, and pushed) or `disagree`, each with why. The hub refuses replies that miss a finding, name one
  twice or lack a why; a finding a person dismissed needs none. Each reply is kept on its finding (`finding.reply`) and
  shown under it on the card, beside Send back, Dismiss and Make a card. A runner keeps a round of replies apart from
  the card itself (`replies:<card id>` and the card's id in `busy`), as both use the card's worktree and session.
- One round only, so it can't loop: the reviewer is never sent the replies, nothing starts on its own, and once the
  author has replied (`challenge.replies.state` done) the hub refuses another round for those findings. A round that
  failed, or that the author left for half an hour, may be asked again; a new Challenge brings new findings without
  replies, and isn't started while a round is under way.
- A binder can post its Challenges to GitHub (Settings → Binders, "Post a Challenge's findings as review comments";
  `binder.reviewComments`, off unless turned on). When findings come in for a card with a pull request, the hub's
  `ReviewsSaver` posts one review through the GitHub App, `event: COMMENT` (it neither approves nor asks for changes):
  each finding a line comment at its file and line, on the new file's side, or the old file's when only a removed line
  has that number; findings on no line of the diff, and the summary, go in the review's body. If GitHub refuses the
  lines (new commits moved them), it posts again with every finding in the body. The review's address, or why it
  couldn't be posted, is kept on the Challenge (`challenge.review`) and linked from the card. A Challenge that finds
  nothing posts nothing.
- Each finding has three actions under it (`POST /api/cards/:id/findings/:finding`, `action`): **Send back** records a
  person's comment on the card with the finding in full (where, what goes wrong, how sure and how bad, the fix) and
  moves the card back to In progress under the agent that wrote it (its holder, or its pull request's agent), so its
  runner carries on with it as with an answer (`resumeFor`); **Dismiss** sets it aside, and *Open again* undoes that;
  **Make a card** puts a new card on the board, ready, in the same binder and note, with the finding as its brief. What
  was done is kept on the finding (`outcome`: who, when, the agent or card), and the Change sets screen counts the open
  ones. A new Challenge brings new findings, open again.
  A debrief is also written at a commit: `PullRequest.head` comes from the pull request webhook and, where
  webhooks don't reach the hub, from asking GitHub, and when it moves on the card says the debrief is out of date.
  `get_change_set` then lists only the commits that landed since (`out_of_date`, read with GitHub's compare), and
  asking again needs `since`: what those commits changed, which the debrief keeps (`debrief.since`) and opens with,
  above its five sections.

## People and GitHub (built)

- GitHub is connected from Settings with GitHub's App manifest flow: the hub posts a manifest (callback, webhook with
  its events, permissions), GitHub makes the app and returns its id, keys and webhook secret, which the hub keeps sealed.
  Installing the app picks repos; the hub signs a JWT with the app's key and mints installation tokens per repo. The
  maker (or the first GitHub sign-in, if they set it up signed in by name) is the admin; the owner's organization is let in.

- Sign-in with GitHub (OAuth, scopes `repo read:org`), with the token kept in the session sealed with `HUB_SECRET`;
  `HUB_ALLOWED_USERS` / `HUB_ALLOWED_ORGS` say who's let in. Every `/api` call needs the session, and every change also
  the web app's own header, which another site can't send.
- Apps (Binders for Mac) open `/auth/app?state=…&app=…` in the browser. After GitHub sign-in (or at once, if the
  browser is signed in already) the hub mints a person token (`bnp_…`, only its hash kept, with the person's GitHub
  token sealed beside it) and redirects to `binders://auth?token=…&state=…&hub=…`; it goes nowhere but a `binders://`
  link, and the app checks the state is its own. The app sends it as `Authorization: Bearer bnp_…` on `/api/*` and
  `/api/live`, with no x-binders header (no cookie, so nothing cross-site). `GET /api/tokens` lists a person's apps
  (the account page, `#/account`, from your picture at the top), `DELETE /api/tokens/:id` signs one out; a revoked or unknown token gets 401.
- Cards become issues in their binder's repo (hidden `<!-- binders … -->` block, `stage:` and `size:` labels, closed
  when done); an issue edited or closed on GitHub comes back; the hub's own writes are recognised and not taken back.
- A pull request is linked to its card by `binders-card: <id>` in its description, `Closes #12` naming the card's issue,
  or `12-` in its branch, and joins its binder's open change set with its files and checks.
- Approving a set approves and merges each pull request on GitHub in order; a failed merge stops there and the set goes
  back to review.


## People's terminals (built)

A person's MCP client (Claude Code, Cursor, another) connects as the person, not as an agent: the hub is an OAuth 2.1
authorization server for MCP, and GitHub only says who they are. A client discovers it from a 401, registers itself
(`/oauth/register`), the person signs in with GitHub and allows it (`/oauth/authorize`), and it exchanges a code with
PKCE for a person token that runs out and renews (`/oauth/token`, `/oauth/revoke`). The token is `bnp_…`, bound to one
binder (`/<binder>/mcp`) and revocable from the account page. It's refused at any other binder's address, once the person
leaves that binder, and on `/api`. It reads and writes notes, makes and comments on cards,
assigns them, and reads change sets, debriefs and Challenges. It takes no work: that's an agent's, with its `bnd_…`
token and runner. Replacing an agent's token doesn't touch a person's connection.


## Jira, and swarms (built)

**Jira** is the first adapter past GitHub, on the boundaries the design names: the binder's own connection (a Jira Cloud address, service account, project, the status each stage is) in the hub's store, sealed; a saver that mirrors cards still going into issues as edits settle, finds them again by a label naming the card, and tries again when Jira won't take a write; a webhook that hears only about issues the saver made. A status moves the card only when someone other than the service account changed it, and by the same rules as moving it on the board. The hub keeps the words: Jira's description is written, never read back, so nothing loops. Changing the address needs the token again and starts a new mirror, since issue ids mean nothing at another address.

**The mapping fills itself in.** Connecting reads the service account's projects, then the chosen project's issue types and each type's workflow, and nothing is kept until it's saved. A note's type is one Stories can sit under (hierarchy level 1, Epic before Feature), a card's is level 0 (Story before Task). Each stage goes to one status: its usual name when the workflow has it, otherwise by the category Jira sorts the status into. Every other status counts as a stage when someone moves an issue there, except ones that ended without being done (Won't Do, Cancelled), which count as nothing.

**A note is an Epic.** With a note type set, the first of a note's cards to be accepted makes its Epic, from its title and words, found again by a label naming the note. The notes it links to come after its words, and those they link to, each once and only from its own binder, so the Epic can be read on its own; edits to any of them follow, and what doesn't fit in a description is named instead. Agents get the same notes from `get_note`. Its cards go under it, those already in Jira as well, and edits to the note follow. Some projects require an Epic Name, which is filled in from the title. If Jira won't have a card under the Epic, the card is still mirrored and says so. A deleted Epic isn't made again. Without a note type, cards stand alone as before.

**What goes each way.** A card's stage, size as story points, and what's said on it go to Jira; a status someone changes and their comments come back. Where a workflow has no direct way to a mapped status, the issue goes through the statuses between, never one that ends the work. If it can't get there, or Jira refuses, the card says so and the board keeps its stage. Coming back works from a look at Jira every minute, with a webhook only making it sooner. The hub knows its own moves by where they went, since the token may be a person's own account, and its own comments by how they start.

**A card goes by its issue's key.** Once mirrored, a card shows its Jira key where it showed its change set's number, and links to the issue. People and agents can name a card by it. A change set keeps its own number on its own screen, since it can hold several cards.

A card **split for a swarm** becomes parts: only a ready card that no agent holds can be split, and each part is a card that names its parent, meant for the agent it's given, carrying the parent's brief, its note and whatever the parent was waiting for. The parent is never offered to an agent while it has parts, and when the last part is live it follows. The parts' pull requests join the binder's open change set like any others. One level of parts; a part isn't split again.

## Live runs (an experiment, on each agent's runner settings)

Three settings that build on each other, all off by default.

**Held runs.** A card's run lives in a small process of its own, a holder, which keeps what the program writes in a file and serves it over a socket. The runner can stop, update or crash and the agent carries on; the next runner reads the file again and tells the card only what it hadn't. If the holder goes with no word of how the program ended, the machine restarted, say, the card starts again in the same conversation. Its service stopping or restarting, an update, or a restart asked for from the Agents page leaves it running, for the next runner. Ctrl-C and `binders remove` are a person ending it: its cards go back on the board.

**The binders command.** With no MCP config and no token in its environment, an agent works its card through a `binders` command on its PATH, which asks its runner over a local socket. A run's secret lets it speak about its own card and nothing else. It can also open terminals of its own, kept to the card's work and listed on the card for its owner to open, which end with the card.

**Hearing while it works.** What people write on a card reaches a running agent without stopping it: through Claude Code's hooks after each tool call and at the end of its turn, or from `binders inbox`. One that doesn't take it within 90 seconds is stopped and told, as before.

**Live terminals.** Claude Code runs in its own interface in a held terminal its owner can open from the card, watch, type to and take over. Its hooks tell the card what it does. A run whose turn ends with the card unfinished is reminded once, then ended, unless a person has typed to it: then it's theirs until they're done.

**Permissions on the card.** A live run's `PermissionRequest` hook puts what Claude Code wants to do on the card, with Allow and Deny for the agent's owner, as only they open a terminal on its machine. An answer goes back through the hook that asked, tied to that request, so nothing an agent writes to the card can approve anything. No answer in nine minutes, a person typing in its terminal, or a runner that goes away, and the hook returns nothing: Claude Code asks in its own terminal, as it would have.

## Work that runs on its own (built)

The nightly example: a schedule scans the repos, its run writes a note, the note is distilled, the work goes to agents, and
their pull requests form a change set. A person approves it. Nothing here approves or merges anything.

**Schedules.** On the timer, a schedule fires through the log (`schedule.fire`), first come first served and never for a time
before the last, so several hubs on one log fire it once. "Run now" is separate: each click is a run. Each firing is kept on the schedule (`runs`, the last 20) with its card, or why it skipped or
failed, and `failing` says what's wrong until a run goes right. A last run nobody has taken holds up the next, so runs don't
pile up; one being worked on holds it up until nothing has happened on it for `staleHours` (24 by default); one in review
holds up nothing. A schedule whose note, agent or folder is gone turns itself off and says why.

**A run's note.** A schedule with `folderId` tells its run to write its findings with `write_run_note` (`binders run-note`),
one note for the run, in that folder. A run with nothing to report writes none, so nothing downstream starts.

**A folder's rule** (`state.folderRules`, set by a Binder's owners and admins) applies to the notes in a folder and in folders
inside it, the nearest rule winning. Its Distill starts once for each note (`note.distill`, again first come first served):
a run's note when its run is over, a person's after `quietMinutes` with no edit. Notes last edited before the rule was turned
on are left alone, as is a note a schedule runs. Editing a note afterwards doesn't distill it again, and a rule starts at most
20 a day. A note moved into the folder with an old edit is left alone until someone edits it.

**Accepting without a person.** A rule's `accept` says how many cards a note may become, of what sizes, and for which agents.
Only the agent the rule names, holding the Distill card the hub made, gets this: another agent proposing for the same note
waits for a person, as ever, and so does what comes of a note another agent wrote. A proposal's `meant_for` counts only if it's
one of the rule's agents. What's over the limits stays a proposal, and the log decides the limit (`proposal.take`). These cards
are only for the agent chosen: agents can't reassign them, and if that agent goes they wait for a person. What an agent
suggests with `create_task` while it has such work out, up to a person's review of it, stays proposed: no agent can hand it
on, and that agent can't hand on anyone's proposed card meanwhile.
A card accepted this way says so in its brief and on its timeline, with who set the rule.

The note may carry words from outside (scanner output, advisories, READMEs), so this is a path from those words to agents with
repo access. What keeps that in bounds: the Distill's brief and each accepted card's say the note's words are information and
not instructions, the rule's limits and its fixed list of agents, the agent's own access and permissions, and the person who
approves the change set. The briefs help and can't be relied on; the limits, the list and the approval are enforced by the hub.
Choose those agents with only the access they need.

**A note's own change set.** `changeSetOf` gives a note's choice (`noteWork.changeSet`), then its folder's rule, then shared.
A pull request from a note with its own set goes in that note's assembling set (`forNote`), and the shared set takes everything
else. Once nothing from the note is still to do and nothing is proposed and waiting, the hub sends the set for review.

**Agents talking.** `message_agent` (`binders message`) writes a `message` on a card the other agent holds, and on the sender's
own for people to read. It reaches the other's run the way a person's words do, marked `(another agent, not a person)`. It
never wakes a stopped agent, doesn't count as a person's last word, and can't answer a permission or a question: while its card
waits on a person, another agent's words aren't passed on. Two agents get
20 messages an hour between them before they're told to ask a person. An agent reaches only agents working in binders it works
in, and a Challenge's reviewer and the author it's judging can't message each other.
