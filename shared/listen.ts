// Listeners: the ways something comes into a Binder from outside it. A listener belongs to one binder, and what it hears
// becomes notes in a folder there, where the folder's rule takes over. A source can be told (it posts to an address the
// hub gives out) or asked (the hub reads it every so often), so a hub nothing can reach still hears. How strongly
// something was said is decided by the hub from who sent it, never from its words.

/** post: an address anything can post to. feed: an address the hub reads. github: issues the hub didn't make. */
export type ListenerKind = 'post' | 'feed' | 'github'

/**
 * How strongly something was said. asked: by someone in the Binder, to the hub. heard: by someone in the Binder, or
 * through an address only they can reach. outside: by anyone else. Nothing outside is acted on: it waits for a person.
 */
export type Strength = 'asked' | 'heard' | 'outside'

export interface Listener {
  id: string
  /** The binder its notes go in. */
  binderId: string
  name: string
  kind: ListenerKind
  /** off: it hears nothing. watch: it says what it would do, and does nothing. on: it does it. */
  mode: 'off' | 'watch' | 'on'
  /** The folder its notes go to, by name: made at the top of the binder when it isn't there. */
  folder: string
  /** A post address: who has it. Only people in this Binder (what comes is heard), or anyone (it's from outside). */
  from?: 'binder' | 'anyone'
  /** A feed: the address the hub reads, and how many minutes between looks. */
  url?: string
  everyMinutes?: number
  createdAt: string
  createdBy: string
  /** Why it can't hear, until it can: a feed that doesn't answer. */
  failing?: string
}

/** One thing a source says happened, as every listener hands it over. */
export interface Heard {
  /** The source's own name for it: the same one handed over twice is heard once. */
  sourceId: string
  /** What it belongs with at the source: a mail's thread, a conversation, an issue. */
  thread?: string
  /** When it happened there, as an ISO date. */
  at?: string
  /** Who sent it, as far as the source says. `login` only when the source proves it (GitHub). */
  sender?: { name?: string; address?: string; login?: string; bot?: boolean }
  title?: string
  text: string
  /** Where it is at the source. */
  url?: string
}

/** Where a note came from, kept on it. */
export interface NoteFrom {
  listener: string
  /** The listener's name and kind when it arrived: the listener may be renamed or gone since. */
  name: string
  kind: ListenerKind
  strength: Strength
  sender?: string
  url?: string
  /** A person in the Binder read it and let it through: its folder's rule may distill it now. */
  passed?: { by: string; at: string }
}

/** What became of something heard, in the hub's words: one row of "Came in". */
export interface Outcome {
  id: string
  listener: string
  listenerName: string
  at: string
  sender?: string
  title: string
  strength: Strength
  /** noted: it's a note. would-note: in Watch, it would be. held: over the listener's limit. undone: taken back. */
  did: 'noted' | 'would-note' | 'held' | 'undone'
  line: string
  /** The note it made. */
  note?: string
  url?: string
}

/** The most a listener takes in an hour: past it, what comes is held, and its admins can see why. */
export const heardPerHour = 120
/** How long what was heard is remembered, and how many rows "Came in" keeps. */
export const heardDays = 30
export const heardKept = 500
/** The most of one thing's words that are kept. */
export const heardMost = 20_000

/** How strongly something was said, from the listener it came through and who sent it. `member`: whether a login is in the Binder. */
export function strengthOf(listener: Pick<Listener, 'kind' | 'from'>, heard: Pick<Heard, 'sender'>, member: (login: string) => boolean): Strength {
  if (heard.sender?.bot) return 'outside'
  if (listener.kind === 'github') return heard.sender?.login && member(heard.sender.login) ? 'heard' : 'outside'
  if (listener.kind === 'post') return listener.from === 'binder' ? 'heard' : 'outside'
  return 'outside'
}

/** Whether a note's folder rule may distill it without a person: not one from outside until someone has let it through. */
export const mayDistill = (from: NoteFrom | undefined) => !from || from.strength !== 'outside' || !!from.passed

/** Whether work from a note may be accepted without a person: only what was asked of the hub, by someone in the Binder. */
export const mayAccept = (from: NoteFrom | undefined) => !from || from.strength === 'asked'
