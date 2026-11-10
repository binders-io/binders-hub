import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Actions } from '../hub/src/actions.ts'
import { Auth } from '../hub/src/auth.ts'
import { GitHubConnection } from '../hub/src/githubConnection.ts'
import { Hub } from '../hub/src/hub.ts'
import { MemoryKV } from '../hub/src/kv.ts'
import { MemoryLog } from '../hub/src/log.ts'
import { Sealer } from '../hub/src/secrets.ts'
import { buildServer } from '../hub/src/server.ts'
import { Spaces, type Space, type SpaceInfo } from '../hub/src/spaces.ts'
import { SpaceBrain } from '../hub/src/brain/brain.ts'
import { BrainSettingsStore } from '../hub/src/brain/settings.ts'
import { demoBrain } from './brain.ts'
import { demoBinder, demoChanges, demoAgents, demoPeople } from './data.ts'

// A hub to look at, and nothing else: everything it holds is invented (data.ts) and lives in this process. It reads no
// settings from the environment, so it can't open a real hub's Redis, notes or keys, it listens on this machine only,
// and its GitHub is a port nothing answers on, so no change it records can reach a repo. Its Brain is a few answers
// written down (brain.ts), not a model: nothing it's asked leaves this process.

const nowhere = 'http://127.0.0.1:9'

/** A GitHub that says it's connected, so the screens read as a set-up hub's, and has no way of reaching anything. */
class NoGitHub extends GitHubConnection {
  status() {
    return { ...super.status(), server: true, webhooks: true }
  }
}

export async function startDemoHub(port: number, webDir = resolve(import.meta.dirname, '../web/dist')) {
  const files = await mkdtemp(join(tmpdir(), 'binders-demo-'))
  const sealer = new Sealer(randomBytes(32).toString('hex'))
  const kv = new MemoryKV()
  const endpoints = { webUrl: nowhere, apiUrl: nowhere }
  const url = `http://127.0.0.1:${port}`
  // No model is read from the environment: the Brain here is the stand-in, and nothing else.
  const brains = await new BrainSettingsStore(new MemoryKV(), sealer, {}).load()
  brains.useForTests(demoBrain)

  const start = async (id: string, info: SpaceInfo): Promise<Space> => {
    const github = new NoGitHub(new MemoryKV(), sealer, endpoints, {}, id)
    await github.load()
    const hub = new Hub(new MemoryLog())
    await hub.start(info.personal ? [{ type: 'binder.put', binder: { id: 'notes', name: 'Notes', createdBy: info.personal } }] : demoChanges())
    // Who may change a locked note, as the hub proper says it: the Binder's owners and admins, and the hub's while it has no owner.
    hub.lockManager = (login) => spaces.mayManage(id, login, spaces.hubAdmin(login))
    const actions = new Actions(hub, github)
    const brain = new SpaceBrain({ id, hub, kv: new MemoryKV(), settings: brains, embeds: false })
    brain.start()
    return { id, hub, actions, github, webhooks: undefined as never, filesDir: join(files, id), brain }
  }

  const spaces = new Spaces(kv, start)
  await spaces.load({ id: demoBinder.space, name: demoBinder.name, members: demoPeople.map((login, i) => ({ login, role: i ? 'member' : 'owner' })) })
  const auth = new Auth(kv, sealer, { github: () => undefined, allowed: () => ({ users: demoPeople, orgs: [] }), devLogin: () => true, oauth: () => undefined, endpoints })
  const app = await buildServer(spaces, { auth, brain: brains }, { publicUrl: url, webDir })
  await app.listen({ port, host: '127.0.0.1' })

  // The agents show as listening, as they would with their runners on, for as long as this runs.
  const space = spaces.get(demoBinder.space)!
  const hub = space.hub
  for (const agent of demoAgents) hub.touch(agent, 1)
  const listening = setInterval(() => { for (const agent of demoAgents) hub.touch(agent) }, 30_000)

  return {
    /** Harbor's hub, for a script that wants changes to land while a page is open. */
    hub,
    /** The same hub's actions, so a script can drive an agent's turn as its runner would. */
    actions: space.actions,
    url,
    /** The address to open, signed in or at the sign-in screen, which takes any name. */
    binder: `${url}/${demoBinder.space}/`,
    stop: async () => {
      clearInterval(listening)
      await app.close()
      await rm(files, { recursive: true, force: true })
    },
  }
}

// `npm run hub [port]`: runs until stopped, to click around in or record.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hub = await startDemoHub(Number(process.argv[2] ?? 4480))
  console.log(`A demo hub, all invented and gone when it stops, at ${hub.binder}\nSign in as ${demoPeople[0]}.`)
  const stop = () => void hub.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
