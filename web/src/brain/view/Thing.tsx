import { ArrowUpRight, Bot, GitPullRequestArrow, Rocket, SquareKanban } from 'lucide-react'
import type { ReactNode } from 'react'
import { asksOf, type ChangeSetState } from '../../../../shared/work.ts'
import { stages } from '../../data/model'
import { isOnline, useHub } from '../../data/store'
import { space, spaceHref } from '../../data/space'
import { href, type Route } from '../../route'

// A card, change set, environment or agent in a view. When it's in the Binder this page is on, and the store has it, it
// is drawn from the store, so it stays as true as the board. Otherwise it's the title and detail the hub gave with the
// view. Either way the row opens the thing: in place when it's here, at its own Binder's address when it isn't.

type Kind = 'card' | 'set' | 'env' | 'agent'
interface Given { kind: Kind; binder: string; id: string; title: string; detail?: string | null }

const icons = { card: SquareKanban, set: GitPullRequestArrow, env: Rocket, agent: Bot } as const
const kindNames = { card: 'Card', set: 'Change set', env: 'Environment', agent: 'Agent' } as const

const routeOf = (kind: Kind, id: string): Route =>
  kind === 'card' ? { screen: 'work', id } : kind === 'set' ? { screen: 'changes', id } : kind === 'env' ? { screen: 'delivery' } : { screen: 'agents' }

const setStandings: Record<ChangeSetState, string> = { assembling: 'Taking pull requests', review: 'In review', merging: 'Approved, merging', merged: 'Merged', shipped: 'Shipped' }
const envStandings = { healthy: 'Healthy', deploying: 'Deploying', waiting: 'Waiting', failed: 'Failed' } as const

const clip = (text: string, most: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > most ? `${one.slice(0, most - 1)}…` : one
}

function Row({ given, here, title, detail }: { given: Given; here: boolean; title: string; detail?: string }) {
  const Icon = icons[given.kind]
  const to = href(routeOf(given.kind, given.id))
  const link = here ? to : spaceHref(given.binder, to)
  return (
    <a className={`view-thing view-thing-${given.kind}`} href={link}>
      <Icon size={16} aria-hidden="true" />
      <span className="view-thing-words">
        <span className="view-thing-title"><span className="view-sr">{kindNames[given.kind]}: </span>{title}</span>
        {detail ? <span className="view-thing-detail">{detail}</span> : null}
      </span>
      {here ? null : <ArrowUpRight size={13} aria-hidden="true" />}
    </a>
  )
}

function LiveCard({ given }: { given: Given }) {
  const card = useHub((state) => state.cards.find((c) => c.id === given.id))
  const agent = useHub((state) => state.agents.find((a) => a.id === card?.agentId)?.name)
  if (!card) return <AsGiven given={given} here />
  const asks = asksOf(card)
  const stage = stages.find((s) => s.id === card.stage)?.title ?? card.stage
  const doing = asks ? `Asks: ${clip(asks, 140)}` : card.stage === 'working' && card.doing ? clip(card.doing, 140) : undefined
  return <Row given={given} here title={card.title} detail={[stage, agent, doing].filter(Boolean).join(' · ')} />
}

function LiveSet({ given }: { given: Given }) {
  const set = useHub((state) => state.changeSets.find((s) => s.id === given.id))
  if (!set) return <AsGiven given={given} here />
  const title = `Change set #${set.number}${set.title ? `: ${set.title}` : ''}`
  return <Row given={given} here title={title} detail={`${setStandings[set.state] ?? set.state} · ${set.prIds.length} pull request${set.prIds.length === 1 ? '' : 's'}`} />
}

function LiveEnvironment({ given }: { given: Given }) {
  const env = useHub((state) => state.environments.find((e) => e.id === given.id))
  if (!env) return <AsGiven given={given} here />
  return <Row given={given} here title={`${env.repo ? `${env.repo} ` : ''}${env.name}`} detail={`${env.version || 'Nothing deployed yet'} · ${envStandings[env.state] ?? env.state}`} />
}

function LiveAgent({ given }: { given: Given }) {
  const agent = useHub((state) => state.agents.find((a) => a.id === given.id))
  // Whether it's online comes from presence, which is live and not in the log: reading it here makes this draw again when it changes.
  useHub((state) => state.presence[given.id])
  const holding = useHub((state) => state.cards.filter((c) => c.agentId === given.id && (c.stage === 'working' || c.stage === 'blocked')).map((c) => clip(c.title, 60)).join('\n'))
  if (!agent) return <AsGiven given={given} here />
  const titles = holding ? holding.split('\n').map((t) => `“${t}”`).join(', ') : ''
  return <Row given={given} here title={agent.name} detail={`${isOnline(agent) ? 'Online' : 'Offline'} · ${titles ? `working on ${titles}` : 'not working on anything'}`} />
}

/** The thing as the hub described it with the view. */
function AsGiven({ given, here }: { given: Given; here: boolean }) {
  return <Row given={given} here={here} title={given.title} detail={given.detail ?? undefined} />
}

export function Thing(given: Given): ReactNode {
  const here = given.binder === space
  if (!here) return <AsGiven given={given} here={false} />
  if (given.kind === 'card') return <LiveCard given={given} />
  if (given.kind === 'set') return <LiveSet given={given} />
  if (given.kind === 'env') return <LiveEnvironment given={given} />
  return <LiveAgent given={given} />
}
