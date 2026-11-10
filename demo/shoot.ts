import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, hostname, userInfo } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'
import { demoIds, demoPeople } from './data.ts'

// The site's pictures of the Hub, in light and dark: `npm run shots -- <folder>` (see README.md), or the film's, larger and
// of more screens, with `npm run shots -- <folder> film`, or only some of them, named: `… film change-set,test-plan`. Each is taken from a throwaway hub (hub.ts) and refused if the
// page holds anything real or asked for anything from elsewhere.

interface Kind {
  size: { width: number; height: number }
  scale: number
  quality: number
  shots: Shot[]
  /** The file a picture goes in, without .webp. */
  file: (name: string, scheme: 'light' | 'dark') => string
}

interface Shot {
  name: string
  hash: string
  /** On the screen once it's ready. */
  ready: string
  /** The tab to open first, on a change set. */
  tab?: string
  /** Scrolled to, to the top of the screen. */
  scroll?: string
}

const kinds: Record<'site' | 'film', Kind> = {
  site: {
    size: { width: 1600, height: 1000 }, scale: 1.5, quality: 0.86,
    file: (name, scheme) => `${name}${scheme === 'dark' ? '-dark' : ''}`,
    shots: [
      { name: 'hub-flow', hash: '#/flow', ready: '.columns .card.working' },
      { name: 'hub-card', hash: `#/work/${demoIds.card}`, ready: '.sdlc .now' },
      // A change set's tabs keep their ids: `changes` is called Pull requests on screen, and `review` is called Challenge.
      { name: 'hub-change-set', hash: `#/changes/${demoIds.set}`, ready: '.stack .pull .diff', tab: 'set-tab-changes' },
      { name: 'hub-challenge', hash: `#/changes/${demoIds.set}`, ready: '.findings .finding', tab: 'set-tab-review' },
      { name: 'hub-delivery', hash: '#/delivery', ready: '.envs .env' },
    ],
  },
  // The Hub film's: a 1440 by 900 window at 2×, which stays sharp pushed in on, of the whole way from note to production.
  film: {
    size: { width: 1440, height: 900 }, scale: 2, quality: 0.92,
    file: (name, scheme) => `shot-${name}-${scheme}`,
    shots: [
      { name: 'home', hash: '#/', ready: '.home-stats' },
      { name: 'flow', hash: '#/flow', ready: '.columns .card.working' },
      { name: 'note', hash: `#/notes/${demoIds.note}`, ready: '.proposals .proposal-card' },
      { name: 'card', hash: `#/work/${demoIds.card}`, ready: '.sdlc .now' },
      { name: 'card-steps', hash: `#/work/${demoIds.card}`, ready: '.tasks li', scroll: '.work-section:has(.tasks)' },
      { name: 'blocked', hash: `#/work/${demoIds.blocked}`, ready: '.sdlc .now' },
      { name: 'change-set', hash: `#/changes/${demoIds.set}`, ready: '#set-panel-debrief', tab: 'set-tab-debrief' },
      { name: 'challenge', hash: `#/changes/${demoIds.set}`, ready: '.findings .finding', tab: 'set-tab-review' },
      { name: 'test-plan', hash: `#/changes/${demoIds.set}`, ready: '#test-plan .test', tab: 'set-tab-debrief', scroll: '#test-plan' },
      { name: 'delivery', hash: '#/delivery', ready: '.envs .env' },
      { name: 'agents', hash: '#/agents', ready: '.agent-card' },
      { name: 'briefs', hash: '#/settings', ready: '.brief-card' },
    ],
  },
}

/** What must never show, in lower case: this machine and whoever runs this, any token, and DEMO_NEVER's words (comma-separated: your team, your hosts). */
export function realWords() {
  const git = (key: string) => { try { return execFileSync('git', ['config', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
  const who = [userInfo().username, homedir(), hostname(), git('user.name'), git('user.email')].filter(Boolean)
  return [...who, ...who.flatMap((w) => w.split(/\s+/)).filter((w) => w.length > 3), ...(process.env.DEMO_NEVER ?? '').split(',').map((w) => w.trim()).filter(Boolean), '/users/', '/home/', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_', 'sk-ant-'].map((w) => w.toLowerCase())
}

const freePort = () => new Promise<number>((done, fail) => {
  const probe = createServer()
  probe.once('error', fail)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number }
    probe.close(() => done(port))
  })
})

/** Everything the page holds, not only what shows: a title or a link is as public once it's on the site's page. */
async function refuseAnythingReal(page: Page, name: string, words: string[]) {
  const html = (await page.evaluate(() => document.documentElement.outerHTML)).toLowerCase()
  const found = words.filter((word) => html.includes(word))
  if (found.length) throw new Error(`${name} shows something real: ${found.join(', ')}`)
}

/** A PNG as WebP, encoded by the browser: Playwright only writes PNG and JPEG, and this needs nothing more installed. */
async function toWebp(browser: Browser, png: Buffer, quality: number) {
  const page = await browser.newPage()
  const data = await page.evaluate(async ({ b64, quality }) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const image = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(image.width, image.height)
    canvas.getContext('2d')!.drawImage(image, 0, 0)
    const out = await canvas.convertToBlob({ type: 'image/webp', quality })
    const bytes = new Uint8Array(await out.arrayBuffer())
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(text)
  }, { b64: png.toString('base64'), quality })
  await page.close()
  return Buffer.from(data, 'base64')
}

async function signIn(context: BrowserContext, url: string) {
  const answer = await context.request.post(`${url}/auth/dev`, { headers: { 'x-binders': '1' }, data: { login: demoPeople[0] } })
  if (!answer.ok()) throw new Error(`Couldn’t sign in to the demo hub: ${answer.status()}`)
}

async function main(folder: string | undefined, which = 'site', only?: string) {
  if (!folder) throw new Error('Say where the pictures go: npm run shots -- <folder>, usually site/assets in binders-io/app.')
  if (which !== 'site' && which !== 'film') throw new Error(`Pictures for the site, or for the film: not “${which}”.`)
  const { size, scale, quality, file } = kinds[which]
  const named = only?.split(',').map((n) => n.trim()).filter(Boolean)
  const shots = named?.length ? kinds[which].shots.filter((s) => named.includes(s.name)) : kinds[which].shots
  if (named?.length && shots.length !== named.length) throw new Error(`No such picture: ${named.filter((n) => !shots.some((s) => s.name === n)).join(', ')}.`)
  const out = resolve(folder)
  await mkdir(out, { recursive: true })
  const { chromium } = await import('playwright')
  const { startDemoHub } = await import('./hub.ts')
  const hub = await startDemoHub(await freePort())
  const browser = await chromium.launch()
  const words = realWords()
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: size, deviceScaleFactor: scale, colorScheme: scheme, reducedMotion: 'reduce', locale: 'en-US' })
      // Nothing from anywhere else: not a font, a picture or a person's avatar.
      const elsewhere: string[] = []
      await context.route('**/*', (route) => {
        const asked = route.request().url()
        if (asked.startsWith(hub.url) || asked.startsWith('data:')) return route.continue()
        elsewhere.push(asked)
        return route.abort()
      })
      // A note opens on Distill and Settings on Repo briefs, as someone who'd been there last would see them.
      await context.addInitScript(() => {
        localStorage.setItem('binders-note-side', 'distill')
        localStorage.setItem('binders-settings-part', 'briefs')
      })
      await signIn(context, hub.url)
      const page = await context.newPage()
      for (const shot of shots) {
        await page.goto(`${hub.binder}${shot.hash}`)
        if (shot.tab) await page.locator(`#${shot.tab}`).click()
        await page.locator(shot.ready).first().waitFor()
        if (shot.scroll) await page.locator(shot.scroll).first().evaluate((element) => element.scrollIntoView({ block: 'start' }))
        await page.evaluate(() => document.fonts.ready)
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
        await page.waitForTimeout(600)
        await refuseAnythingReal(page, shot.name, words)
        if (elsewhere.length) throw new Error(`${shot.name} asked for something elsewhere: ${elsewhere.join(', ')}`)
        const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
        const webp = await toWebp(browser, png, quality)
        const name = `${file(shot.name, scheme)}.webp`
        await writeFile(resolve(out, name), webp)
        console.log(`${name}  ${size.width * scale}×${size.height * scale}  ${Math.round(webp.length / 1024)} KB`)
      }
      await context.close()
    }
  } finally {
    await browser.close()
    await hub.stop()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2], process.argv[3], process.argv[4])
