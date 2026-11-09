import { patchLines, type Challenge, type Debrief, type Finding } from '../shared/changeSet.ts'
import { runnerVersion, type AgentTool } from '../shared/agents.ts'
import { briefNoteText, docsFolderName } from '../shared/briefs.ts'
import type { Schedule } from '../shared/schedule.ts'
import type { Change } from '../shared/state.ts'
import { environmentId, type Activity, type Agent, type Card, type ChangeSet, type Chat, type Environment, type FileDiff, type FolderRule, type Proposal, type PullRequest, type Run } from '../shared/work.ts'

// Everything the demo hub shows, and all of it invented: Harbor, its people and its repos are the same made-up team the
// Mac app's demo uses (Binders/App/DemoData.swift in binders-io/app). One piece of work runs through every screen:
// the note on annual plans, the cards it became, change set #11 on staging waiting to go to production, and change set
// #12 in review with its Challenge. Dates are counted back from when it runs, so the pictures never look old.

export const demoBinder = { space: 'harbor', id: 'harbor', name: 'Harbor', repo: 'example/harbor' }
/** The first is who the screenshots are signed in as. */
export const demoPeople = ['maya', 'priya', 'jonas']
export const demoAgents = ['claude-web', 'claude-api', 'codex', 'cursor']
/** The screens the pictures are of. */
export const demoIds = { note: 'annual-plans', card: 'card-settings-switch', blocked: 'card-beta', set: 'cs-12' }

const web = 'example/web'
const api = 'example/api'
const emails = 'example/emails'

const noteText = `# Annual plans

Customers keep asking for a yearly price, and Priya wants it live before the spring renewals.

## What we're doing

- Two months free on every plan when paid yearly.
- A monthly or annual toggle on the pricing page, with monthly as the default.
- Anyone on a monthly plan can switch from account settings, with the unused days credited.
- A reminder 30 days before an annual plan renews, sent once.

## Not yet

- Annual invoices by bank transfer.
- Changing the prices themselves.

## Open

- What happens to the beta customers' 20% discount?
`

// A note the team settled and locked, with a change an agent has proposed to it: the one place a note can't just be
// edited, so the proposal is what people review.
const termsText = `# Renewal terms

What a customer agrees to when they pay for a year.

## Renewals

- An annual plan renews on the same day of the same month, a year later.
- We email 30 days before it renews, once, and again if the card fails.
- A failed card gets 14 days of grace before the plan drops to free.

## Cancelling

- Cancel any time from account settings; the plan runs to the end of the year paid for.
- No refunds part way through a year, except where the law says otherwise.
`

const termsProposed = termsText.replace(
  '- A failed card gets 14 days of grace before the plan drops to free.',
  '- A failed card gets 14 days of grace before the plan drops to free.\n- Grace is counted from the first failed attempt, not the last retry.',
)

const webBrief = `## What it is

Harbor's customer-facing web app: the marketing pages, pricing, sign-up and checkout, and Account. React and Vite, served
as static files; everything it knows comes from example/api.

## Map

- \`src/pricing/\`: the pricing page. \`plans.ts\` is the only place plan names and prices are read; never hard-code one.
- \`src/checkout/\`: checkout, driven entirely by the \`?plan=\` and \`?interval=\` it's opened with.
- \`src/account/\`: Account → Billing, Profile and Team. \`Billing.tsx\` loads the subscription once and passes it down.
- \`src/api/\`: one function per API call, typed from example/api's OpenAPI file (\`npm run api:types\`).

## Rules it keeps

- Prices are in cents everywhere, and only \`formatPrice\` turns them into text.
- A logged-out visitor can reach everything under \`/pricing\` and \`/checkout\`; nothing else.
- Feature flags are read through \`useFlag\`, never from \`window\`.

## Build, test, run

- \`npm test\` (about 40 s) and \`npm run e2e\` (about 4 min, needs \`API_URL\` pointed at a preview API).
- CI runs both on every pull request; staging deploys \`main\` on merge.

## Where it breaks

- Checkout links built by hand lose the interval. Use \`checkoutUrl(plan, interval)\`.
- \`Compare.tsx\` and \`landing/Plans.tsx\` also render \`PlanCard\`: change its props and check both.

## Reviewing a change here

1. Does every price still come from \`plans.ts\` and pass through \`formatPrice\`?
2. Does the pricing page still work logged out, on a phone?
3. Is there an e2e test from the pricing page through to checkout for anything that touches either?
`

const apiBrief = `## What it is

Harbor's billing and accounts API: Node and Postgres, the only thing that talks to the payment provider.

## Map

- \`src/routes/\`: one file per resource. \`subscriptions.ts\` owns every change to a subscription.
- \`src/billing/\`: prices, proration and invoices. \`plans.ts\` is the price table.
- \`jobs/\`: scheduled jobs, run by the worker every morning at 06:00 UTC.

## Rules it keeps

- Money changes happen inside \`db.transaction\`, with the subscription row locked.
- An invoice is never edited after it's sent: a correction is a new credit note.

## Build, test, run

\`npm test\` needs Postgres (\`docker compose up db\`, about 3 min). Migrations run with \`npm run migrate\`.
`

const harborBrief = `## What it is

Where Harbor's work is tracked: its cards are issues here, and its notes are saved here on their own branch. No code.

## Rules it keeps

- Labels are set by Binders; don't rename them by hand.
`

const deploying = `# Deploying

- Merging to \`main\` deploys staging. Production is promoted from Binders' Delivery screen and needs Priya or Maya.
- A release that touches billing waits a day on staging before production.
- Roll back by promoting the previous version; never revert on \`main\` to roll back.
`

/** One file of a diff, from a patch as git writes it. */
function file(path: string, patch: string): FileDiff {
  const lines = patchLines(patch)
  return { path, added: lines.filter((l) => l.kind === '+').length, removed: lines.filter((l) => l.kind === '-').length, lines }
}

const prorate = file('src/billing/prorate.ts', `@@ -0,0 +1,13 @@
+import { daysBetween } from '../dates'
+import type { Subscription } from './types'
+
+const DAYS_IN_CYCLE = 30
+
+/** What's left of this month's payment, taken off the first annual invoice. */
+export function creditForSwitch(sub: Subscription, now: Date) {
+  const used = daysBetween(sub.cycleStart, now)
+  const unused = DAYS_IN_CYCLE - used
+  return Math.round(sub.monthlyCents * (unused / DAYS_IN_CYCLE))
+}
+
+export const annualCents = (monthlyCents: number) => monthlyCents * 10`)
const switchRoute = file('src/routes/subscriptions.ts', `@@ -41,6 +41,14 @@ router.get('/subscriptions/:id', async (req, res) => {
   res.json(await subscriptions.find(req.params.id))
 })
 
+router.post('/subscriptions/:id/switch-to-annual', async (req, res) => {
+  const sub = await subscriptions.find(req.params.id)
+  const credit = creditForSwitch(sub, new Date())
+  const invoice = await invoices.create(sub, annualCents(sub.monthlyCents) - credit)
+  await subscriptions.update(sub.id, { interval: 'year', cycleStart: invoice.paidAt })
+  res.json({ invoice })
+})
+
 router.delete('/subscriptions/:id', async (req, res) => {
   await subscriptions.cancel(req.params.id)
   res.status(204).end()`)
const toggle = file('src/pricing/PlanToggle.tsx', `@@ -0,0 +1,16 @@
+import { useState } from 'react'
+import { PlanCard } from './PlanCard'
+import { plans } from './plans'
+
+export function PlanToggle() {
+  const [interval, setInterval] = useState<'month' | 'year'>('month')
+  return (
+    <>
+      <div role="group" aria-label="Billing">
+        <button aria-pressed={interval === 'month'} onClick={() => setInterval('month')}>Monthly</button>
+        <button aria-pressed={interval === 'year'} onClick={() => setInterval('year')}>Annual · two months free</button>
+      </div>
+      {plans.map((plan) => <PlanCard key={plan.id} plan={plan} interval={interval} />)}
+    </>
+  )
+}`)
const planCard = file('src/pricing/PlanCard.tsx', `@@ -8,8 +8,8 @@ interface Props {
-export function PlanCard({ plan }: Props) {
-  const price = legacyMonthlyPrice(plan)
+export function PlanCard({ plan, interval }: Props) {
+  const price = interval === 'year' ? plan.annualCents / 12 : plan.monthlyCents
   return (
     <article className="plan">
       <h3>{plan.name}</h3>
-      <p className="price">{formatPrice(price)} a month</p>
-      <a href={\`/checkout?plan=\${plan.id}\`}>Start</a>
+      <p className="price">{formatPrice(price)} a month{interval === 'year' ? ', billed yearly' : ''}</p>
+      <a href={\`/checkout?plan=\${plan.id}&interval=month\`}>Start</a>
     </article>`)
const reminder = file('jobs/renewal-reminder.ts', `@@ -0,0 +1,10 @@
+import { send } from '../mail'
+import { renewingWithin } from '../subscriptions'
+import renewal from '../templates/renewal.mjml'
+
+/** Runs every morning. */
+export async function renewalReminder() {
+  for (const sub of await renewingWithin({ days: 30 })) {
+    await send(sub.billingEmail, renewal, { renewsOn: sub.renewsOn, amount: sub.annualCents })
+  }
+}`)
const billingApi = file('src/billing/plans.ts', `@@ -3,6 +3,7 @@ export interface Plan {
   id: string
   name: string
   monthlyCents: number
+  annualCents: number
 }`)

export function demoChanges(now = Date.now()): Change[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  const hours = 60
  const days = 24 * hours
  // A time of day in this machine's zone, as cron has it: the demo's schedules read as the times a person would pick.
  const at = (hour: number, minute = 0) => `${minute} ${hour} * * *`
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  const agent = (id: string, name: string, provider: Agent['provider'], tool: AgentTool, runsOn: string, owner: string, repos: string[], models: string[], skills: string[]): Agent => ({
    id, name, provider, owner, repos, binders: [], skills, runsOn, createdAt: ago(40 * days), lastSeen: ago(0), models,
    runner: { tool, access: tool === 'claude' ? 'auto' : 'full', timeoutMinutes: 60, worktrees: true, parallel: 2, ...(models[0] ? { model: models[0] } : {}) },
    runnerSeen: { version: runnerVersion, parallel: 2, at: ago(0) },
  })
  const agents = [
    agent('claude-web', 'Claude Code · web', 'claude', 'claude', 'Studio Mac', 'maya', [web], ['opus', 'sonnet'], ['react', 'e2e tests']),
    agent('claude-api', 'Claude Code · api', 'claude', 'claude', 'Build server', 'maya', [api, emails], ['opus', 'sonnet'], ['billing', 'postgres']),
    agent('codex', 'Codex', 'openai', 'codex', 'Build server', 'priya', [], [], ['review', 'distill']),
    agent('cursor', 'Cursor', 'cursor', 'cursor', 'Laptop', 'jonas', [web], [], ['css', 'copy']),
  ]

  const act = (minutes: number, by: string, kind: Activity['kind'], text: string, more: Partial<Activity> = {}): Activity => ({ at: ago(minutes), by, kind, text, ...more })
  const step = (minutes: number, by: string, tool: string, text: string, result?: string) => act(minutes, by, 'step', text, { tool, ...(result ? { result } : {}) })
  let issue = 226
  const card = (id: string, title: string, stage: Card['stage'], minutes: number, fields: Partial<Card> & { brief: string; doneWhen: string }): Card => ({
    id, binderId: demoBinder.id, title, size: 'M', stage, createdAt: ago(minutes + 3 * days), createdBy: 'maya', updatedAt: ago(minutes), noteId: demoIds.note, waitsFor: [],
    issue: { repo: demoBinder.repo, number: issue++, url: '' },
    activity: [act(minutes + 3 * days, 'maya', 'created', 'accepted it from the note')],
    ...fields,
  })

  // The commits the two merged pull requests made on api's main: what its environments' own commits are compared with.
  const mergeShas: Record<string, string> = { [`${api}#311`]: 'c4e91a07b2d83f56a1904c7be28d5f3a96b07e41', [`${api}#318`]: '9a3f60d2e7b14c85f20a6d913be4780c5a1fd2e6' }
  const pull = (repo: string, number: number, title: string, branch: string, cardId: string, agentId: string, state: PullRequest['state'], files: FileDiff[]): PullRequest => ({
    id: `${repo}#${number}`, repo, number, title, branch: `binders/${branch}`, url: '', state, cardId, agentId, files, mergeable: state === 'merged' ? undefined : 'clean', head: `${number}f3a9c`,
    ...(state === 'merged' ? { mergeSha: mergeShas[`${repo}#${number}`] } : {}),
    checks: [{ name: 'test', state: 'passed', seconds: 148 }, { name: 'typecheck', state: 'passed', seconds: 41 }, { name: 'e2e', state: 'passed', seconds: 263 }],
  })
  const pulls = [
    pull(api, 311, 'Plan prices in one table', 'card-plan-table', 'card-plan-table', 'claude-api', 'merged', [billingApi]),
    pull(api, 318, 'Annual prices in the billing API', 'card-annual-api', 'card-annual-api', 'claude-api', 'merged', [billingApi]),
    pull(api, 322, 'Switch a monthly plan to annual, with a credit', 'card-switch-api', 'card-switch-api', 'claude-api', 'open', [prorate, switchRoute]),
    pull(web, 214, 'Monthly or annual toggle on the pricing page', 'card-toggle', 'card-toggle', 'claude-web', 'open', [toggle, planCard]),
    pull(emails, 42, 'Renewal reminder 30 days before an annual plan ends', 'card-reminder', 'card-reminder', 'claude-api', 'open', [reminder]),
  ]

  // Change set #12's Challenge: Codex reads what the two Claude Code agents wrote, and all of it together.
  const finding = (id: string, pullId: string, fileName: string, line: number, severity: Finding['severity'], confidence: Finding['confidence'], kind: Finding['kind'], what: string, fix: string): Finding => ({ id, pull: pullId, file: fileName, line, severity, confidence, kind, what, fix })
  const findings = [
    finding('f1', `${api}#322`, 'src/billing/prorate.ts', 9, 'high', 'confirmed', 'bug', 'A cycle is taken as 30 days, so someone switching on day 31 of a long month has −1 unused days and a negative credit: their first annual invoice charges them extra instead of crediting them.', 'Use the length of their actual cycle, and never credit below zero.'),
    finding('f2', `${web}#214`, 'src/pricing/PlanCard.tsx', 14, 'high', 'confirmed', 'done-when', 'The Start link always says interval=month. A visitor who picks Annual sees the annual price, then checks out on the monthly plan.', 'Pass the chosen interval into the checkout link, and test it from the toggle through to checkout.'),
    finding('f3', `${emails}#42`, 'jobs/renewal-reminder.ts', 7, 'medium', 'confirmed', 'done-when', 'The job runs every morning and picks everyone renewing within 30 days, so each customer gets the reminder 30 times. The done-when says once.', 'Record when the reminder went out and skip those, or select only subscriptions renewing in exactly 30 days.'),
    finding('f4', `${api}#322`, 'src/routes/subscriptions.ts', 47, 'medium', 'plausible', 'edge case', 'Two quick clicks on Switch could create two annual invoices: nothing stops the second request while the first is still running.', 'Refuse the switch when the subscription is already yearly, inside one transaction.'),
    finding('f5', `${web}#214`, 'src/pricing/PlanToggle.tsx', 6, 'low', 'confirmed', 'simpler', 'The state is called setInterval, hiding the browser’s function of the same name in this file.', 'Call it setBilling.'),
  ]
  // The authors' one round of replies: Claude Code · web fixed the small one at once; the rest wait for Maya.
  findings[4].reply = { verdict: 'fixed', why: 'Renamed it setBilling, in PlanToggle and its test. Pushed to web#214.', by: 'claude-web', at: ago(33) }
  const challengeBase: Challenge = {
    state: 'done', askedBy: 'maya', askedAt: ago(52), effort: { level: 'medium', auto: true, lines: 84 }, agentId: 'codex', picked: 'hub', authors: ['claude-api', 'claude-web'], reviewedAt: ago(38), source: 'pull',
    summary: 'Close, but not ready. The credit can go negative, and the pricing page’s annual choice never reaches checkout, so both main paths charge people the wrong amount. The reminder goes out daily rather than once.',
  }
  const challenge: Challenge = {
    ...challengeBase, findings, replies: { state: 'done', askedBy: 'maya', askedAt: ago(36), agentId: 'claude-web', repliedAt: ago(33) },
    blast: {
      at: ago(50), repo: web, outside: 9, stillUsed: 1, untested: 2,
      symbols: [
        { name: 'creditForSwitch', file: `${api}#322: src/billing/prorate.ts`, change: 'added', uses: [], tests: ['test/billing/prorate.test.ts'] },
        { name: 'annualCents', file: `${api}#322: src/billing/prorate.ts`, change: 'added', uses: [{ file: 'src/invoices/create.ts', line: 27, text: 'const total = annualCents(plan.monthlyCents)' }], tests: [] },
        { name: 'PlanCard', file: `${web}#214: src/pricing/PlanCard.tsx`, change: 'changed', uses: [{ file: 'src/pricing/Compare.tsx', line: 33, text: '<PlanCard plan={plan} />' }, { file: 'src/landing/Plans.tsx', line: 12, text: '<PlanCard plan={featured} />' }], more: 4, tests: ['test/pricing/plan-card.test.tsx'] },
        { name: 'legacyMonthlyPrice', file: `${web}#214: src/pricing/PlanCard.tsx`, change: 'removed', uses: [{ file: 'src/account/Invoices.tsx', line: 58, text: 'legacyMonthlyPrice(subscription.plan)' }], tests: [] },
        { name: 'renewalReminder', file: `${emails}#42: jobs/renewal-reminder.ts`, change: 'added', uses: [], tests: [] },
      ],
    },
  }
  const onPull = (pullId: string): Challenge => ({ ...challengeBase, fromSet: 'cs-12', findings: findings.filter((f) => f.pull === pullId) })

  const debrief: Debrief = {
    state: 'done', askedBy: 'maya', askedAt: ago(30), effort: { level: 'medium', auto: true, lines: 84 }, agentId: 'codex', writtenAt: ago(24), source: 'pull',
    head: pulls.slice(2).map((p) => `${p.id}@${p.head}`).join(' '),
    does: 'Lets customers pay yearly with two months free: a toggle on the pricing page, a switch in the billing API that credits the unused days, and a reminder before renewal.',
    changes: [
      { area: 'Billing', what: 'A new endpoint switches a monthly subscription to annual and invoices the difference.' },
      { area: 'Pricing page', what: 'A toggle between monthly and annual prices, with monthly as the default.' },
      { area: 'Email', what: 'A morning job sends the renewal reminder.' },
    ],
    against: [
      { point: 'Annual costs ten months of the monthly price', mark: 'met', where: 'src/billing/prorate.ts:13' },
      { point: 'Visitors can choose annual on the pricing page and check out on it', mark: 'partly met', where: 'The toggle works, but the checkout link stays monthly' },
      { point: 'Unused days are credited when switching', mark: 'partly met', where: 'Wrong on day 31 of a long month' },
      { point: 'The reminder goes out once, 30 days before renewal', mark: 'not met', where: 'jobs/renewal-reminder.ts sends every day' },
    ],
    lookAt: ['A removed function, legacyMonthlyPrice, is still used by the invoices page.', 'No test covers the renewal job.'],
    tryIt: 'Open the pricing page on the preview, choose Annual, and follow Start through to checkout.',
    testPlan: [
      {
        id: 't1', title: 'Switching on the last day of a 31-day month credits the right amount', risk: 'high', point: 'Unused days are credited when switching',
        setup: 'A customer on the monthly Team plan ($40) whose month started on March 1.',
        steps: ['Set the preview’s clock to March 31.', 'Sign in as the customer and open Account → Plan.', 'Choose Switch to annual and read the confirmation.', 'Confirm, then open the new invoice.'],
        expect: 'The confirmation and the invoice both credit one unused day ($1.29), never a negative amount, and the annual price is $400.',
      },
      {
        id: 't2', title: 'Checkout charges the annual price when Annual is chosen', risk: 'high', point: 'Visitors can choose annual on the pricing page and check out on it',
        setup: 'Signed out, on the preview’s pricing page.',
        steps: ['Choose Annual on the toggle.', 'Press Start on the Team plan.', 'Go through checkout with the test card 4242 4242 4242 4242.'],
        expect: 'Checkout shows $400 a year, and the receipt and Account → Plan say Annual.',
      },
      {
        id: 't3', title: 'The renewal reminder is sent once, 30 days before renewal', risk: 'high', point: 'The reminder goes out once, 30 days before renewal',
        setup: 'An annual customer whose plan renews in 30 days.',
        steps: ['Run the morning job.', 'Run it again the next day, and the day after.', 'Open the outbox for the customer’s billing contact.'],
        expect: 'Exactly one reminder, sent on the first run, with the renewal date and amount.',
      },
      {
        id: 't4', title: 'Annual costs ten months of the monthly price on every plan', risk: 'medium', point: 'Annual costs ten months of the monthly price',
        steps: ['Open the pricing page and switch between Monthly and Annual.', 'Compare each plan’s two prices.'],
        expect: 'Each annual price is exactly ten times its monthly one: $100, $400 and $1,200.',
        result: { outcome: 'passed', by: 'priya', at: ago(18) },
      },
      {
        id: 't5', title: 'Monthly stays the default on the pricing page', risk: 'low', point: 'Visitors can choose annual on the pricing page and check out on it',
        steps: ['Open the pricing page in a private window.'],
        expect: 'Monthly is selected and monthly prices show until someone chooses Annual.',
        result: { outcome: 'passed', by: 'maya', at: ago(16) },
      },
      {
        id: 't6', title: 'Someone already on annual can’t switch again', risk: 'medium',
        setup: 'A customer already on the annual Team plan.',
        steps: ['Open Account → Plan.', 'Send the switch request twice in quick succession from the browser’s console.'],
        expect: 'No Switch to annual button, and both requests are refused without a second invoice.',
      },
    ],
  }
  const fromSet = { ...debrief, fromSet: 'cs-12' }

  const sets: ChangeSet[] = [
    { id: 'cs-10', binderId: demoBinder.id, number: 10, title: 'One table of plan prices', summary: 'Every plan price in one place, ready for a second interval.', state: 'shipped', prIds: [`${api}#311`], noteIds: [demoIds.note], approvedBy: 'priya' },
    { id: 'cs-11', binderId: demoBinder.id, number: 11, title: 'Annual prices in the API', summary: 'The billing API knows each plan’s annual price. Nothing shows it to customers yet.', state: 'merged', prIds: [`${api}#318`], noteIds: [demoIds.note], approvedBy: 'maya' },
    { id: 'cs-12', binderId: demoBinder.id, number: 12, title: 'Annual plans for customers', summary: 'The pricing page offers annual plans, customers can switch from monthly with a credit, and a reminder goes out before renewal.', state: 'review', prIds: [`${api}#322`, `${web}#214`, `${emails}#42`], noteIds: [demoIds.note], debrief, challenge },
  ]

  const cards: Card[] = [
    card('card-faq', 'Annual plans in the help centre', 'ready', 3 * hours, { size: 'S', quote: 'Two months free on every plan when paid yearly.', brief: 'Add a section on annual plans to the billing help page: the price, switching, the credit and renewal.', doneWhen: 'The help page answers how annual plans are priced, how to switch and when they renew.' }),
    card('card-report', 'Annual plans in the revenue report', 'ready', 5 * hours, { brief: 'The monthly revenue report counts an annual payment as one month. Spread it across its twelve months.', doneWhen: 'A customer paying yearly adds a twelfth of it to each month of the report.', meantFor: 'codex' }),
    card(demoIds.card, 'Switch from monthly to annual in account settings', 'working', 2, {
      agentId: 'claude-web', progress: 0.65, doing: 'Running the settings tests', quote: 'Anyone on a monthly plan can switch from account settings, with the unused days credited.',
      brief: 'Add a Switch to annual button to Account → Billing. Show the annual price and the credit before they confirm, then call the billing API’s switch-to-annual.',
      doneWhen: 'Someone on a monthly plan sees what they’ll pay, confirms, and is on an annual plan with an invoice. Someone already on annual doesn’t see the button.',
      minutes: 23, tokens: 184_300, cost: 1.42,
      plan: [{ text: 'Read how Account → Billing loads the subscription', done: true }, { text: 'Add the switch dialog with the price and the credit', done: true }, { text: 'Call switch-to-annual and show the invoice', done: true }, { text: 'Test both kinds of customer', done: false }, { text: 'Open the pull request', done: false }],
      activity: [
        act(3 * days, 'maya', 'created', 'accepted it from the note'),
        act(26, 'claude-web', 'claimed', 'Claude Code · web took it'),
        step(25, 'claude-web', 'Read', 'src/account/Billing.tsx'),
        step(24, 'claude-web', 'Read', 'src/api/subscriptions.ts'),
        act(21, 'claude-web', 'question', 'The credit depends on change set #12’s API, which isn’t merged. Should I build against its branch and say so in the pull request, or wait for it?'),
        act(17, 'maya', 'answer', 'Build against the branch and say so. It merges first.'),
        step(15, 'claude-web', 'Write', 'src/account/SwitchToAnnual.tsx', '86 lines'),
        step(12, 'claude-web', 'Edit', 'src/account/Billing.tsx', '+9 −1'),
        step(10, 'claude-web', 'Edit', 'src/api/subscriptions.ts', '+12'),
        step(8, 'claude-web', 'Write', 'test/account/switch-to-annual.test.tsx', '54 lines'),
        step(5, 'claude-web', 'Bash', 'npm test -- account', '1 failed, 17 passed'),
        step(4, 'claude-web', 'Edit', 'src/account/SwitchToAnnual.tsx', '+3 −2'),
        act(3, 'claude-web', 'said', 'The failure was the dialog showing the credit before it had loaded. Fixed; running them again.'),
        step(2, 'claude-web', 'Bash', 'npm test -- account', '18 passed ✓'),
      ],
    }),
    card('card-receipt', 'Show the saving on the annual receipt', 'working', 7, { quote: 'Two months free on every plan when paid yearly.', size: 'S', agentId: 'codex', progress: 0.3, doing: 'Reading the receipt template', brief: 'Annual receipts say how much was saved against twelve monthly payments.', doneWhen: 'An annual receipt shows the saving; a monthly one doesn’t change.', activity: [act(9, 'codex', 'claimed', 'Codex took it')] }),
    card(demoIds.blocked, 'Annual price for the beta customers', 'blocked', 11, {
      agentId: 'claude-api', needsYou: 'Do beta customers keep their 20% discount on annual plans, or take the two months free instead?', quote: 'What happens to the beta customers’ 20% discount?',
      brief: 'Beta customers have 20% off for life. Work out what they pay on an annual plan.', doneWhen: 'A beta customer’s annual price follows what was decided, with a test.',
      activity: [act(30, 'claude-api', 'claimed', 'Claude Code · api took it'), step(28, 'claude-api', 'Read', 'src/billing/discounts.ts'), step(25, 'claude-api', 'Bash', 'git log -S beta --oneline -- src/billing', '3 commits'), step(22, 'claude-api', 'Read', 'docs/beta-terms.md'), step(19, 'claude-api', 'Read', 'test/billing/discounts.test.ts'), act(12, 'claude-api', 'said', 'The beta terms promise 20% off any plan and never mention annual ones. Either reading is defensible, so I’m asking rather than picking.'), act(11, 'claude-api', 'question', 'Do beta customers keep their 20% discount on annual plans, or take the two months free instead?')],
    }),
    card('card-switch-api', 'Switch a monthly plan to annual, with a credit', 'review', 60, { quote: 'Anyone on a monthly plan can switch from account settings, with the unused days credited.', agentId: 'claude-api', prId: `${api}#322`, progress: 1, debrief: fromSet, challenge: onPull(`${api}#322`), brief: 'An endpoint that moves a monthly subscription to annual and credits the unused days.', doneWhen: 'Unused days are credited when switching.', activity: [act(4 * hours, 'claude-api', 'claimed', 'Claude Code · api took it'), step(3.6 * hours, 'claude-api', 'Read', 'src/routes/subscriptions.ts'), step(3.1 * hours, 'claude-api', 'Write', 'src/billing/prorate.ts', '13 lines'), step(2.4 * hours, 'claude-api', 'Bash', 'npm test -- billing', '42 passed ✓'), act(72, 'claude-api', 'ran', 'finished its run', { tokens: 412_800, cost: 3.18 }), act(70, 'claude-api', 'pr', 'opened api#322')] }),
    card('card-toggle', 'Monthly or annual toggle on the pricing page', 'review', 58, { quote: 'A monthly or annual toggle on the pricing page, with monthly as the default.', agentId: 'claude-web', prId: `${web}#214`, progress: 1, debrief: fromSet, challenge: onPull(`${web}#214`), brief: 'A toggle on the pricing page, monthly by default, that changes the prices and what Start buys.', doneWhen: 'Visitors can choose annual on the pricing page and check out on it.', activity: [act(3 * hours, 'claude-web', 'claimed', 'Claude Code · web took it'), step(2.7 * hours, 'claude-web', 'Write', 'src/pricing/PlanToggle.tsx', '16 lines'), step(1.9 * hours, 'claude-web', 'Bash', 'npm run e2e -- pricing', '9 passed ✓'), act(63, 'claude-web', 'ran', 'finished its run', { tokens: 268_400, cost: 2.04 }), act(62, 'claude-web', 'pr', 'opened web#214')] }),
    card('card-reminder', 'Renewal reminder 30 days before an annual plan ends', 'review', 56, { quote: 'A reminder 30 days before an annual plan renews, sent once.', size: 'S', agentId: 'claude-api', prId: `${emails}#42`, progress: 1, debrief: fromSet, challenge: onPull(`${emails}#42`), brief: 'Email the billing contact 30 days before an annual plan renews.', doneWhen: 'The reminder goes out once, 30 days before renewal.', activity: [act(2.2 * hours, 'claude-api', 'claimed', 'Claude Code · api took it'), step(1.6 * hours, 'claude-api', 'Write', 'jobs/renewal-reminder.ts', '10 lines'), act(67, 'claude-api', 'ran', 'finished its run', { tokens: 121_900, cost: 0.92 }), act(66, 'claude-api', 'pr', 'opened emails#42')] }),
    card('card-annual-api', 'Annual prices in the billing API', 'live', 6 * hours, { agentId: 'claude-api', prId: `${api}#318`, brief: 'Each plan has an annual price, ten times its monthly one.', doneWhen: 'Annual costs ten months of the monthly price.', activity: [act(6.5 * hours, 'claude-api', 'ran', 'finished its run', { tokens: 96_400, cost: 0.74 }), act(6 * hours, 'maya', 'moved', 'approved change set #11'), act(5 * hours, 'hub', 'merged', 'merged api#318'), act(40, 'hub', 'deployed', 'deployed v2.41.0 to staging')] }),
    card('card-plan-table', 'Plan prices in one table', 'live', 2 * days, { size: 'S', agentId: 'claude-api', prId: `${api}#311`, brief: 'Move plan prices out of the code into one table.', doneWhen: 'Every price comes from the table.', activity: [act(2 * days, 'hub', 'deployed', 'deployed v2.40.2 to production')] }),
  ]

  const runs: Run[] = [
    { id: 'r7', workflow: 'ci', target: 'binders/card-settings-switch', repo: web, state: 'running', seconds: 0, at: ago(1) },
    { id: 'r6', workflow: 'ci', target: 'binders/card-reminder', repo: emails, state: 'passed', seconds: 204, at: ago(60) },
    { id: 'r5', workflow: 'ci', target: 'binders/card-toggle', repo: web, state: 'passed', seconds: 452, at: ago(64) },
    { id: 'r4', workflow: 'ci', target: 'binders/card-switch-api', repo: api, state: 'passed', seconds: 263, at: ago(71) },
    { id: 'r3', workflow: 'deploy', target: 'staging v2.41.0', repo: api, state: 'passed', seconds: 186, at: ago(40) },
    { id: 'r2', workflow: 'ci', target: 'main', repo: api, state: 'passed', seconds: 271, at: ago(47) },
    { id: 'r1', workflow: 'deploy', target: 'production v2.40.2', repo: api, state: 'passed', seconds: 213, at: ago(2 * days) },
  ]

  // The api repo's two environments, in the order they're deployed to. Staging has everything merged; production is a
  // version behind, and its deploy workflow waits for someone to press Promote. The web and emails repos have no
  // pull request merged yet and nothing deployed, so they have none.
  const [shaOf311, shaOf318] = [mergeShas[`${api}#311`], mergeShas[`${api}#318`]]
  const environments: Environment[] = [
    { id: environmentId(api, 'Staging'), repo: api, order: 0, name: 'Staging', url: 'https://api.staging.harbor.example', version: 'v2.41.0', sha: shaOf318, pullIds: [`${api}#318`, `${api}#311`], changeSetIds: ['cs-11', 'cs-10'], state: 'healthy', deployedAt: ago(40), needsApproval: false, by: 'github' },
    { id: environmentId(api, 'Production'), repo: api, order: 1, name: 'Production', url: 'https://api.harbor.example', version: 'v2.40.2', sha: shaOf311, pullIds: [`${api}#311`], changeSetIds: ['cs-10'], state: 'healthy', deployedAt: ago(2 * days), needsApproval: true, deploy: { repo: api, workflow: 'deploy.yml', ref: 'main' }, by: 'person' },
  ]

  // What Distill proposed from the note that people took: each is a card on the board now.
  const accepted = cards.filter((c) => c.quote && c.stage !== 'live').map((c): Proposal => ({
    id: `p-${c.id}`, binderId: demoBinder.id, noteId: demoIds.note, title: c.title, quote: c.quote!, brief: c.brief, doneWhen: c.doneWhen, size: c.size, by: 'codex', state: 'accepted', cardId: c.id,
  }))

  // The note on a timer, and the folder that distills what's finished in it: the hub working with nobody watching.
  const schedules: Schedule[] = [
    {
      id: 's-plans', noteId: demoIds.note, binderId: demoBinder.id, agentId: 'claude-web', cron: at(9), tz, enabled: true, createdAt: ago(9 * days), createdBy: 'maya',
      folderId: 'plans', staleHours: 24, lastRun: ago(2 * days), lastCardId: 'card-faq', lastDue: ago(2 * days), lastClaim: 'demo',
      runs: [{ at: ago(2 * days), by: 'timer', cardId: 'card-faq' }, { at: ago(9 * days), by: 'timer', cardId: 'card-report' }],
    },
    {
      id: 's-briefs', noteId: 'brief-web', binderId: demoBinder.id, agentId: 'claude-web', cron: at(7, 30), tz, enabled: true, createdAt: ago(6 * days), createdBy: 'maya',
      staleHours: 24, lastRun: ago(2 * days), lastCardId: 'card-toggle', lastDue: ago(2 * days), lastClaim: 'demo',
      runs: [{ at: ago(2 * days), by: 'timer', cardId: 'card-toggle' }],
    },
  ]

  const rules: FolderRule[] = [
    { id: 'rule-plans', binderId: demoBinder.id, folderId: 'plans', enabled: true, distill: true, agentId: 'codex', quietMinutes: 10, accept: { maxCards: 5, sizes: ['S', 'M'], agents: ['claude-web', 'claude-api'] }, changeSet: 'shared', since: ago(9 * days), createdAt: ago(9 * days), createdBy: 'maya' },
  ]

  const chats: Chat[] = [
    {
      id: `chat-${demoIds.note}-codex`, noteId: demoIds.note, agentId: 'codex',
      messages: [
        { at: ago(34), by: 'maya', text: 'The open question on the beta discount: what does the code actually do today?' },
        { at: ago(33), by: 'codex', text: 'Beta customers get 20% off whatever plan they’re on, and the discount is applied after the interval is chosen, so an annual plan would get it too. Nothing in the terms says annual plans are different.' },
        { at: ago(31), by: 'maya', text: 'Then keep the discount and drop the two months free for them. Add that to the note.' },
        { at: ago(30), by: 'codex', text: 'Added under “What we’re doing”: beta customers keep their 20% and don’t also get the two months. The card that was blocked on it can go ahead.' },
      ],
    },
  ]

  return [
    { type: 'binder.put', binder: { id: demoBinder.id, name: demoBinder.name, createdBy: 'maya', repo: demoBinder.repo } },
    { type: 'folder.put', folder: { id: 'plans', binderId: demoBinder.id, name: 'Plans' } },
    { type: 'folder.put', folder: { id: 'repo-docs', binderId: demoBinder.id, name: docsFolderName } },
    { type: 'folder.put', folder: { id: 'docs-web', binderId: demoBinder.id, name: web, parentId: 'repo-docs' } },
    { type: 'folder.put', folder: { id: 'docs-harbor', binderId: demoBinder.id, name: demoBinder.repo, parentId: 'repo-docs' } },
    { type: 'folder.put', folder: { id: 'docs-api', binderId: demoBinder.id, name: api, parentId: 'repo-docs' } },
    { type: 'note.put', note: { id: demoIds.note, title: 'Annual plans', binderId: demoBinder.id, folderId: 'plans', commit: '3e1f9a2', path: 'harbor/plans/annual-plans.md', editedAt: ago(4 * days), editors: ['maya', 'priya'], text: noteText } },
    { type: 'note.put', note: { id: 'renewal-terms', title: 'Renewal terms', binderId: demoBinder.id, folderId: 'plans', commit: 'b41d7e0', path: 'harbor/plans/renewal-terms.md', editedAt: ago(11 * days), editedBy: 'priya', editors: ['priya', 'maya'], text: termsText } },
    { type: 'note.lock', id: 'renewal-terms', locked: { by: 'priya', at: ago(11 * days) } },
    { type: 'noteProposal.put', proposal: { id: 'np-grace', noteId: 'renewal-terms', binderId: demoBinder.id, by: 'claude-api', at: ago(5), why: 'The retry job runs three times over two days, so “14 days” is counted from the last retry in the code. The note should say which.', base: termsText, text: termsProposed, state: 'open', comments: [{ by: 'priya', at: ago(3), text: 'Good catch. Say it plainly and I’ll accept it.' }] } },
    { type: 'note.put', note: { id: 'brief-web', title: 'Brief', binderId: demoBinder.id, folderId: 'docs-web', commit: 'a7c2d10', editedAt: ago(2 * days), editedBy: 'claude-web', editors: ['claude-web', 'maya'], text: briefNoteText(webBrief) } },
    { type: 'note.put', note: { id: 'brief-api', title: 'Brief', binderId: demoBinder.id, folderId: 'docs-api', commit: '5b08e4f', editedAt: ago(5 * days), editedBy: 'claude-api', editors: ['claude-api'], text: briefNoteText(apiBrief) } },
    { type: 'note.put', note: { id: 'brief-harbor', title: 'Brief', binderId: demoBinder.id, folderId: 'docs-harbor', commit: 'e40f2c8', editedAt: ago(8 * days), editedBy: 'codex', editors: ['codex'], text: briefNoteText(harborBrief) } },
    { type: 'note.put', note: { id: 'deploying', title: 'Deploying', binderId: demoBinder.id, folderId: 'repo-docs', commit: 'c93a71b', editedAt: ago(9 * days), editedBy: 'priya', editors: ['priya'], text: deploying } },
    { type: 'brief.put', brief: { id: web, repo: web, noteId: 'brief-web', sha: '8c41e07d2b9a', writtenAt: ago(2 * days), writtenBy: 'claude-web', lessons: [
      { at: ago(20 * hours), by: 'claude-web', text: 'npm run e2e fails locally unless API_URL points at a preview API; the default is production and it refuses.' },
      { at: ago(3 * hours), by: 'maya', text: 'Annual prices are shown per month, with “billed yearly” after them.' },
    ] } },
    { type: 'brief.put', brief: { id: api, repo: api, noteId: 'brief-api', sha: '1f9d3a6c0e52', writtenAt: ago(5 * days), writtenBy: 'claude-api', lessons: [
      { at: ago(26 * hours), by: 'claude-api', text: 'The proration tests need TZ=UTC: run in another zone, three of them fail on the day boundary.' },
      { at: ago(6 * hours), by: 'priya', text: 'Never change a sent invoice, even in a migration. Issue a credit note.' },
    ] } },
    { type: 'brief.put', brief: { id: emails, repo: emails, ask: { agentId: 'claude-api', askedBy: 'maya', at: ago(4), state: 'writing', doing: 'Reading how the worker schedules jobs' } } },
    { type: 'brief.put', brief: { id: demoBinder.repo, repo: demoBinder.repo, noteId: 'brief-harbor', sha: '77b2e1f04a3d', writtenAt: ago(8 * days), writtenBy: 'codex' } },
    ...agents.map((a): Change => ({ type: 'agent.put', agent: a })),
    { type: 'proposal.put', proposal: { id: 'p-comparison', binderId: demoBinder.id, noteId: demoIds.note, title: 'Annual prices in the plan comparison table', quote: 'A monthly or annual toggle on the pricing page, with monthly as the default.', brief: 'The comparison table under the plans shows the price for the chosen interval.', doneWhen: 'The table’s prices follow the toggle.', size: 'S', by: 'codex', state: 'new', meantFor: 'claude-web' } },
    { type: 'proposal.put', proposal: { id: 'p-downgrade', binderId: demoBinder.id, noteId: demoIds.note, title: 'What happens when someone cancels an annual plan', quote: 'Anyone on a monthly plan can switch from account settings, with the unused days credited.', brief: 'Say what a customer gets back when they cancel part way through a year.', doneWhen: 'Cancelling an annual plan does what the terms say, with a test.', size: 'M', by: 'codex', state: 'new' } },
    ...accepted.map((p): Change => ({ type: 'proposal.put', proposal: p })),
    ...pulls.map((p): Change => ({ type: 'pr.put', pull: p })),
    ...sets.map((s): Change => ({ type: 'set.put', set: s })),
    ...cards.map((c): Change => ({ type: 'card.put', card: c })),
    ...environments.map((environment): Change => ({ type: 'env.put', environment })),
    ...[...runs].reverse().map((r): Change => ({ type: 'run.put', run: r })),
    ...schedules.map((schedule): Change => ({ type: 'schedule.put', schedule })),
    ...rules.map((rule): Change => ({ type: 'rule.put', rule })),
    ...chats.flatMap((chat): Change[] => chat.messages.map((message) => ({ type: 'chat.say', id: chat.id, noteId: chat.noteId, agentId: chat.agentId, message }))),
  ]
}
