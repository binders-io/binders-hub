import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from 'playwright'
import { demoIds, demoPeople } from './data.ts'
import { realWords } from './shoot.ts'

// The Hub film's footage: the real hub, driven, recorded as it moves. `npm run record -- <folder>` writes one WebM for
// each beat (see beats below) into <folder>, and a `beats.json` saying when each began, so the film can be cut from them.
// Everything on screen is invented (data.ts), and the page is refused if it holds anything real or asks for anything
// from anywhere but the throwaway hub.

const size = { width: 1440, height: 900 }

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer()
  probe.once('error', fail)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number }
    probe.close(() => done(port))
  })
})

async function signIn(context: BrowserContext, url: string) {
  const answer = await context.request.post(`${url}/auth/dev`, { headers: { 'x-binders': '1' }, data: { login: demoPeople[0] } })
  if (!answer.ok()) throw new Error(`Couldn’t sign in to the demo hub: ${answer.status()}`)
}

/** Everything the page holds, not only what shows. */
async function refuseAnythingReal(page: Page, name: string, words: string[]) {
  const html = (await page.evaluate(() => document.documentElement.outerHTML)).toLowerCase()
  const found = words.filter((word) => html.includes(word))
  if (found.length) throw new Error(`${name} shows something real: ${found.join(', ')}`)
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** A pointer that moves like a hand: to a place, then a click, so the footage shows what's being done. */
async function glide(page: Page, selector: string, { click = true, settle = 500 } = {}) {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`Nothing to point at: ${selector}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps: 18 })
  await wait(220)
  if (click) {
    await page.mouse.down()
    await wait(70)
    await page.mouse.up()
  }
  await wait(settle)
}

/** A slow scroll of the page's own scroller, so the footage reads as someone reading. */
async function read(page: Page, selector: string, by: number, ms = 1400) {
  const scroller = page.locator(selector).first()
  await scroller.waitFor({ state: 'visible' })
  await scroller.evaluate(async (element, { by, ms }) => {
    const from = element.scrollTop
    const start = performance.now()
    await new Promise<void>((done) => {
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms)
        element.scrollTop = from + by * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
        if (t < 1) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
  }, { by, ms })
}

interface Beat {
  name: string
  /** What the beat is, for the film's captions. */
  caption: string
  run: (page: Page, hub: DemoHub) => Promise<void>
}

type DemoHub = Awaited<ReturnType<typeof import('./hub.ts').startDemoHub>>

const beats: Beat[] = [
  {
    name: 'home',
    caption: 'Every agent, and what it’s doing right now',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/`)
      await page.locator('.home-stats').waitFor()
      await wait(1200)
      await read(page, '.home', 260, 1800)
      await wait(600)
      await read(page, '.home', -260, 1200)
    },
  },
  {
    name: 'agent-works',
    caption: 'An agent takes a card and works it, live',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/`)
      await page.locator('.home-stats').waitFor()
      await wait(900)
      // The agent picks up the card the schedule left ready, and reports as it goes: the tile's terminal fills in.
      hub.hub.touch('claude-web', 1)
      await wait(700)
      await hub.actions.claim('claude-web', 'card-faq')
      await wait(1400)
      const steps: { doing: string; progress: number; steps?: { tool?: string; text: string; result?: string }[]; said?: string }[] = [
        { doing: 'Reading the billing help page', progress: 0.12, steps: [{ tool: 'Read', text: 'docs/billing/annual-plans.md', result: 'Read 84 lines' }] },
        { doing: 'Checking how the price is shown', progress: 0.3, steps: [{ tool: 'Grep', text: 'billed yearly', result: '3 matches in 2 files' }, { tool: 'Read', text: 'web/src/pricing/PlanCard.tsx', result: 'Read 61 lines' }] },
        { doing: 'Writing the section', progress: 0.55, steps: [{ tool: 'Write', text: 'docs/billing/annual-plans.md', result: 'Wrote 46 lines' }], said: 'The help page has no annual section at all: writing one from the pricing code.' },
        { doing: 'Adding the switching steps', progress: 0.78, steps: [{ tool: 'Edit', text: 'docs/billing/annual-plans.md', result: 'Added 12 lines' }] },
        { doing: 'Running the docs checks', progress: 0.92, steps: [{ tool: 'Bash', text: 'npm run check:docs', result: '18 passed ✓' }] },
      ]
      for (const step of steps) {
        await hub.actions.progress('claude-web', 'card-faq', step)
        await wait(1500)
      }
      await wait(1200)
    },
  },
  {
    name: 'flow',
    caption: 'From a note to production, one board',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/flow`)
      await page.locator('.columns .card.working').first().waitFor()
      await wait(1400)
      await read(page, '.columns', 420, 2000)
      await wait(500)
      await read(page, '.columns', -420, 1400)
    },
  },
  {
    name: 'note',
    caption: 'A note, and the work it becomes',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/notes/${demoIds.note}`)
      await page.locator('.note').waitFor()
      await wait(1500)
      await read(page, '.note', 200, 1600)
      await wait(600)
    },
  },
  {
    name: 'chat',
    caption: 'Ask the agent about the note, and it answers',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/notes/${demoIds.note}`)
      await page.locator('.note-chat').waitFor()
      await wait(1200)
      // A person's message, then the agent thinking, then its answer: the same path the app takes.
      await hub.actions.say(demoPeople[0], demoIds.note, 'codex', 'Does the toggle need a new price on the API, or can the web app work it out?')
      await wait(900)
      await hub.hub.record({ kind: 'agent', id: 'codex' }, { type: 'chat.status', id: `chat-${demoIds.note}-codex`, working: true, doing: 'Reading the pricing endpoints' })
      await wait(2200)
      await hub.hub.record({ kind: 'agent', id: 'codex' }, { type: 'chat.say', id: `chat-${demoIds.note}-codex`, noteId: demoIds.note, agentId: 'codex', message: { at: new Date().toISOString(), by: 'codex', text: 'The API already returns both prices on a plan, so the web app can work the yearly one out from what it has. No new endpoint, and nothing to migrate.' } })
      await wait(2600)
    },
  },
  {
    name: 'locked-note',
    caption: 'A locked note: agents propose, people decide',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/notes/renewal-terms`)
      await page.locator('.note-locked').waitFor()
      await wait(1400)
      await glide(page, 'button[aria-label="Versions and proposals"]', { settle: 900 })
      await page.locator('.note-proposal').first().waitFor()
      await wait(1200)
      await read(page, '.dialog-body', 180, 1600)
      await wait(800)
    },
  },
  {
    name: 'card',
    caption: 'What the agent did, step by step',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/work/${demoIds.card}`)
      await page.locator('.sdlc .now').waitFor()
      await wait(1400)
      await read(page, '.work', 420, 2000)
      await wait(600)
    },
  },
  {
    name: 'change-set',
    caption: 'A change set: its debrief, and its review',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/changes/${demoIds.set}`)
      await page.locator('#set-tab-debrief').waitFor()
      await wait(1200)
      await glide(page, '#set-tab-debrief', { settle: 1600 })
      await glide(page, '#set-tab-review', { settle: 1800 })
      await read(page, '.set', 200, 1600)
      await wait(600)
    },
  },
  {
    name: 'delivery',
    caption: 'Staging, then production on your word',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/delivery`)
      await page.locator('.envs .env').first().waitFor()
      await wait(1800)
      await read(page, '.delivery', 160, 1400)
      await wait(600)
    },
  },
  {
    name: 'agents',
    caption: 'Agents, and the notes they run on a timer',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/agents`)
      await page.locator('.agent-card').first().waitFor()
      await wait(1200)
      await page.locator('.schedules-section').first().evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'smooth' }))
      await wait(1800)
      await glide(page, '.schedule-runs summary', { settle: 1600 })
      await wait(800)
    },
  },
  {
    name: 'rules',
    caption: 'A folder’s rules: work nobody has to read first',
    run: async (page, hub) => {
      await page.goto(`${hub.binder}#/notes/${demoIds.note}`)
      await page.locator('.note-tree').waitFor()
      await wait(1000)
      // The row's ⋯ sits under the folder's own label, so it is clicked where it is rather than pointed at.
      await page.locator('.tree-more[aria-label="Actions for Plans"]').dispatchEvent('click')
      await page.locator('.context-menu [role=menuitem]').filter({ hasText: 'Rules' }).first().waitFor()
      await wait(700)
      await page.locator('.context-menu [role=menuitem]').filter({ hasText: 'Rules' }).first().click()
      await page.locator('.dialog .rule-check').first().waitFor()
      await wait(1600)
      await read(page, '.dialog-body', 200, 1600)
      await wait(800)
    },
  },
]

async function main(folder: string | undefined, only?: string) {
  if (!folder) throw new Error('Say where the footage goes: npm run record -- <folder>.')
  const named = only?.split(',').map((n) => n.trim()).filter(Boolean)
  const chosen = named?.length ? beats.filter((b) => named.includes(b.name)) : beats
  if (named?.length && chosen.length !== named.length) throw new Error(`No such beat: ${named.filter((n) => !beats.some((b) => b.name === n)).join(', ')}.`)
  const out = resolve(folder)
  await mkdir(out, { recursive: true })
  const { chromium } = await import('playwright')
  const { startDemoHub } = await import('./hub.ts')
  const hub = await startDemoHub(await freePort())
  const browser = await chromium.launch()
  const words = realWords()
  const timings: { name: string; caption: string; file: string; ms: number }[] = []
  try {
    for (const beat of chosen) {
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US', recordVideo: { dir: out, size } })
      const elsewhere: string[] = []
      await context.route('**/*', (route) => {
        const asked = route.request().url()
        if (asked.startsWith(hub.url) || asked.startsWith('data:')) return route.continue()
        elsewhere.push(asked)
        return route.abort()
      })
      await context.addInitScript(() => {
        localStorage.setItem('binders-note-side', 'chat')
        localStorage.setItem('binders-settings-part', 'briefs')
      })
      await signIn(context, hub.url)
      const page = await context.newPage()
      const started = Date.now()
      await beat.run(page, hub)
      await refuseAnythingReal(page, beat.name, words)
      if (elsewhere.length) throw new Error(`${beat.name} asked for something elsewhere: ${elsewhere.join(', ')}`)
      const video = page.video()
      await context.close()
      const path = await video!.path()
      const file = `${beat.name}.webm`
      await writeFile(resolve(out, file), await (await import('node:fs/promises')).readFile(path))
      const ms = Date.now() - started
      timings.push({ name: beat.name, caption: beat.caption, file, ms })
      console.log(`${file}  ${(ms / 1000).toFixed(1)}s`)
    }
    await writeFile(resolve(out, 'beats.json'), `${JSON.stringify(timings, null, 2)}\n`)
  } finally {
    await browser.close()
    await hub.stop()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2], process.argv[3])
