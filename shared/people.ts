// How a person is shown. Their GitHub login stays who they are everywhere (permissions, the log, allow lists); what's
// shown is the name on their GitHub profile when the hub has seen it, or else their login. An Enterprise Managed User's
// login ends in its enterprise's shortcode (`jdoe_acme`): shown without it, but only for a shortcode the hub knows is
// one (a managed account connected here, an organization the binder's app is installed on, or set on the hub), since an
// underscore alone says nothing.

/** What the hub knows of a person to show them. */
export interface Profile {
  name?: string
  avatar?: string
}

/** A login without its enterprise's shortcode, when it ends in one of `shortcodes` (lower case). */
export function withoutShortcode(login: string, shortcodes: readonly string[] = []) {
  const found = /^(.+)_([A-Za-z0-9]{1,20})$/.exec(login)
  return found && shortcodes.includes(found[2].toLowerCase()) ? found[1] : login
}

/** A person's name to show: their profile's, or their login (without a known enterprise shortcode). */
export function shownName(login: string, people: Record<string, Profile> = {}, shortcodes: readonly string[] = []) {
  return people[login.toLowerCase()]?.name?.trim() || withoutShortcode(login, shortcodes)
}

/** Shortcodes an organization's name suggests: the name, and its first part before a dash (`acme` of `acme-labs`). */
export const shortcodesOf = (accounts: readonly string[]) => [...new Set(accounts.flatMap((a) => [a.toLowerCase(), a.toLowerCase().split('-')[0]]).filter((a) => /^[a-z0-9]{1,20}$/.test(a)))]

/** Everyone a binder's state names: who made, did, edited, asked for or approved something there. */
export function loginsIn(state: {
  cards: { createdBy: string; activity: { by: string }[]; debrief?: { askedBy: string }; challenge?: { askedBy: string } }[]
  notes: { editors: string[]; editedBy?: string }[]
  agents: { owner: string }[]
  changeSets?: { approvedBy?: string }[]
}) {
  const found = new Set<string>()
  const add = (login?: string) => { if (login && login !== 'hub') found.add(login.toLowerCase()) }
  for (const card of state.cards) {
    add(card.createdBy)
    add(card.debrief?.askedBy)
    add(card.challenge?.askedBy)
    for (const a of card.activity) add(a.by)
  }
  for (const note of state.notes) { add(note.editedBy); note.editors.forEach(add) }
  for (const agent of state.agents) add(agent.owner)
  for (const set of state.changeSets ?? []) add(set.approvedBy)
  return found
}
