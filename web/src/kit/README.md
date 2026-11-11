# The kit

The pieces every screen is made of. Import them from `src/kit` (one place), and see each in its states, in both
themes, on the style guide at `#/kit` (linked from nowhere; type it in the address).

```ts
import { PageHeader, Section, Rows, Row, DataTable, type Column, Guided, Dialog, Field, EmptyState, Status, More, MenuButton, Skeleton } from '../kit'
```

Their rules are in `src/styles/90-kit.css`. The tokens they use (space, type, control heights, layers, motion) are in
`src/index.css`; use the tokens in your own rules too, never a number that's on the scale:

| Token | Values |
|---|---|
| Space | `--space-4`, `-8`, `-12`, `-16`, `-24`, `-32`, `-48` |
| Type | `--font-12`, `-13`, `-14` (text), `-16`, `-20`, `-26`, each with `--leading-N` |
| Controls | `--control` (36, 44 on touch), `--control-sm` (28, 44 on touch), `--control-lg` (44) |
| Radii | `--r-xs` 5 (tags), `--r-sm` 7 (controls), `--r` 11 (small cards), `--r-lg` 16 (cards, dialogs), `--r-pill` |
| Layers | `--z-raised`, `--z-panel`, `--z-scrim`, `--z-drawer`, `--z-popover`, `--z-dialog`, `--z-menu`, `--z-toast`, `--z-context`, `--z-skip` |
| Motion | `--dur-fast` 150ms, `--dur` 180ms, `--dur-slow` 220ms, `--ease` and `--ease-out` |
| Focus | `--focus-ring` and `--focus-offset` (every `:focus-visible` already has it) |

The rules of the look, in short: one primary action a screen; things are rows, pressed to change them; one line under
a heading, the rest behind "How this works"; one frame (a section is a title and one card, never a card in a card);
colour only for state.

---

## PageHeader

How a screen starts: its title, one line, and its one primary action. To the right of the title on a wide window; under
the line, as wide as the screen, on a phone (600px and under). Every screen starts with one.

| Prop | |
|---|---|
| `title` | The screen's name. An `h2` under the top bar's `h1` (`level={1}` for a page without the top bar). |
| `lead?` | One line: what the screen is for. |
| `action?` | The one primary action, usually `<button className="button primary">`. |
| `eyebrow?` | A rare small-capitals line over the title ("This binder · Harbor"). |
| `level?`, `id?` | The heading's level and id. |

```tsx
<PageHeader title="Agents" lead="Agents take cards from the board and hand them back as pull requests."
  action={<button type="button" className="button primary" onClick={() => setAdding(true)}><Plus size={16} />Add an agent</button>} />
```

Do: one action; the other ways in go behind it, in a `Guided`. Don't: a row of three buttons, a paragraph as the lead.

Wrap a screen in `<div className="page"><div className="page-column">…</div></div>` for the same padding, width and
scroll as every other (`.page` scrolls; `.page-column` is 880px wide at most and spaces its children 32px apart).

## Section

A part of a screen: a title, an optional one-line lead, an optional action at the right of the title, an optional "How
this works", and one card for what it holds. Inside the card, its parts are divided by hairlines: `Rows`, a
`DataTable`, or plain blocks (a `div` each, padded 16px). A card that finds itself inside (a `.settings-card`,
`.options`, `.status-list`, another section's card) loses its own frame.

| Prop | |
|---|---|
| `title` | An `h3` (`level={2}` when the section is a page's top level). The section is a region named by it. |
| `lead?` | One line under the title. |
| `action?` | One small button at the right of the title: `<button className="button small">Add</button>`. |
| `more?`, `moreLabel?` | The long explanation, behind "How this works" (or `moreLabel`). |
| `card?` | `false` to put what it holds straight under the title, with no card (a lone button, a guided setup). |
| `id?`, `className?` | |

```tsx
<Section title="Listeners" lead="What comes into this binder from outside it."
  action={<button type="button" className="button small" onClick={add}><Plus size={14} />Add</button>}
  more={<p>Each thing a listener hears becomes a note. A new one starts in Watch…</p>}>
  <Rows label="Listeners">{listeners.map((l) => <Row key={l.id} … />)}</Rows>
</Section>
```

Do: one card, hairlines inside. Don't: a card inside it, a paragraph above each control.

## Rows and Row

A list of things. A row has an icon, a title, one line of meta, an optional status, and a trailing control. Given
`onPress` or `href`, the whole row is one real button or link, with a chevron, a hover and the focus ring; the trailing
control (a switch, a `MenuButton`) stays outside it, a target of its own. On its own `Rows` has a card's frame; in a
`Section` it takes the section's.

| `Rows` prop | |
|---|---|
| `label?` | The list's name for a screen reader. |

| `Row` prop | |
|---|---|
| `icon?` | An icon (16px) in a 32px tile, or an avatar. |
| `title` | The thing's name. One line, cut short. |
| `meta?` | One line under it: what it is, how it stands. Cut short, never wrapped. |
| `status?` | A `<Status>`. |
| `trailing?` | `'chevron'` (the default when pressable), `'none'`, or a control: a switch, a `<MenuButton>`. |
| `onPress?` / `href?` | Opens it: in a `Dialog` (a sheet on a phone), or another page. |
| `label?` | The row's name for a screen reader when its words don't say what pressing does. |
| `disabled?`, `current?` | |

```tsx
<Row icon={<Mail size={16} />} title="Support mail" meta="An address to post to · From outside"
  status={<Status tone="ok">On</Status>} onPress={() => setOpen(listener.id)}
  trailing={<MenuButton label="More for Support mail" items={[{ label: 'Remove', danger: true, confirm: 'Remove it? Press again', onSelect: remove }]} />} />
```

Do: words in `title`, `meta` and `status` (they are read out as the row's name). Don't: a button or link inside a
pressable row's title or meta; a form always open in a row (open it in a dialog).

## DataTable

Rows of things with the same few facts each, for a list that may be long. On a wide window, a real `<table>`: its header
sticks to the top of the page as it scrolls, rows are 52px, the whole row is pressable (a click anywhere, and the title
cell is the row's button for a keyboard and a screen reader) with a chevron to say so. On a phone (600px and under),
the same data as stacked rows: the title column, then a line of the `meta` columns. It draws `pageSize` rows at a time
with "Show N more", so thousands cost what one page does; the filter box searches all of them.

| Prop | |
|---|---|
| `label` | The table's name (its caption, for a screen reader). |
| `columns` | `Column<T>[]`, below. |
| `rows`, `rowKey` | The rows, and a stable key for each. |
| `onRowPress?` | Pressing a row: open it in a `Dialog`. |
| `rowLabel?` | What pressing a row does, said for it: `` (r) => `Open ${r.name}` ``. |
| `empty?` | What shows with no rows at all: an `<EmptyState compact …>`. |
| `loading?` | Five skeleton rows, and `aria-busy`. |
| `filter?` | A filter box over the table, with these words as its placeholder and name ("Filter repos"). |
| `pageSize?` | Rows a page; 50. |

| `Column<T>` | |
|---|---|
| `key`, `header` | |
| `cell(row)` | What the cell shows. Text, an icon, a `Status`. Not a button (the row is the button). |
| `text?(row)` | Its words, for the filter. The table filters by the columns that have this. |
| `phone?` | `'title'` (one column; the first otherwise), `'meta'` (the default), or `'hidden'`. |
| `width?` | On a wide window: `'40%'`, `'120px'`. The rest share what's left. Cells are one line, cut short. |
| `align?` | `'end'` for numbers and dates. |

```tsx
const columns: Column<Repo>[] = [
  { key: 'name', header: 'Repo', cell: (r) => r.fullName, text: (r) => r.fullName, phone: 'title', width: '40%' },
  { key: 'brief', header: 'Its brief', cell: (r) => <Status tone={r.brief ? 'ok' : 'off'}>{r.brief ? 'Written' : 'None'}</Status> },
  { key: 'changed', header: 'Changed', cell: (r) => ago(r.pushedAt), align: 'end', phone: 'hidden' },
]
<Section title="Repos" lead="The repos this binder's app is installed on.">
  <DataTable label="Repos" columns={columns} rows={repos} rowKey={(r) => r.fullName} onRowPress={setOpen}
    rowLabel={(r) => `Open ${r.fullName}`} filter="Filter repos" loading={!loaded}
    empty={<EmptyState compact icon={<FolderGit2 size={18} />} title="No repos yet" line="Install the app on an organization." />} />
</Section>
```

Don't: put it in a box that scrolls on its own (the header sticks to the page's scroll); an interactive cell.

## Guided

The guided dialog: one way into something that can be done several ways. Its first step is the choice: each way an
icon, a name, one line, maybe "Recommended". Then the chosen way's steps, with Back in the header, the step's title,
and "Step 2 of 3" with a bar when there are several. Any form goes in as a step's content and keeps its own buttons
(`.form-actions`, kept at the bottom of the dialog, in a thumb's reach on a phone); or give the step a `footer`. Focus
goes to each step's heading, a screen reader is told "Step 2 of 3: …", and Escape and Close work as a `Dialog`'s, on
any step. It is a `Dialog`, so on a phone it is a sheet.

| Prop | |
|---|---|
| `title` | The dialog's name: "Add an agent". |
| `question` | The first step's heading: "What kind?" |
| `lead?` | One line under the question. |
| `options` | `{ id, icon, name, line, recommended?, disabled? }[]` |
| `steps(optionId)` | The chosen way's `GuidedStep[]`: `{ title, lead?, content, footer? }`. `content` and `footer` are nodes, or functions given `nav` (`next`, `back`, `close`, `goTo(i)`, `step`, `steps`). |
| `onClose` | |
| `start?` | An option to start in, skipping the choice (a link that already knows). Back still reaches the choice. |
| `size?` | The dialog's size. |

```tsx
<AnimatePresence>
  {adding && (
    <Guided key="add" title="Add an agent" question="What kind?" onClose={() => setAdding(false)}
      options={[
        { id: 'machine', icon: <Laptop size={18} />, name: 'A machine with your code', line: 'It runs Claude Code or Codex where your repos are.', recommended: true },
        { id: 'model', icon: <Cloud size={18} />, name: 'A model, with no machine', line: 'The hub runs it. It can’t change code.' },
      ]}
      steps={(id) => id === 'machine'
        ? [{ title: 'Which machine?', content: (nav) => <AddMachine onJoined={nav.next} /> },
           { title: 'It joined', content: <Joined />, footer: (nav) => <button className="button primary" onClick={nav.close}>Done</button> }]
        : [{ title: 'Which model?', content: <AddModel onDone={() => setAdding(false)} /> }]} />
  )}
</AnimatePresence>
```

Do: put it inside `AnimatePresence`, as a `Dialog`. Don't: put a second dialog inside a step; give a step both a form's
own buttons and a `footer`.

## Dialog

A form over the page (`components/Dialog.tsx`, also exported here). Its old props work as before; it now has a footer
that stays in view, sizes, and Back, and on a phone (600px and under) it is a sheet from the bottom: rounded at the top,
up to 92% of the height, clear of the home bar, its buttons in a column with the main one last. Every dialog in the app
became a sheet on a phone through this alone.

| Prop | |
|---|---|
| `title`, `onClose`, `children` | As before. |
| `footer?` | Its buttons, the main one last. Kept at the bottom whatever the body holds. A `className="dialog-foot-start"` button (Remove) goes to the left on a wide window. |
| `size?` | `'small'` 420, `'medium'` 520 (the default), `'large'` 720. `wide` is `large`, under its old name. |
| `onBack?` | A Back button before the title. |
| `closeOnlyFromButton?` | As before: only Close shuts it. |

A form inside with `.form-actions` keeps them at the bottom too (they are sticky), so a form needs no change. `Field`
is its name over a box as wide as the form: `<Field label="Name" hint="…"><input /></Field>`.

## EmptyState

Nothing here yet, said once: an icon, one line, an optional second line, an optional action.

`icon?`, `title`, `line?`, `action?`, `compact?` (for inside a card or a table).

```tsx
<EmptyState icon={<Bot size={20} />} title="No agents yet" line="An agent takes cards from the board."
  action={<button type="button" className="button primary small" onClick={add}>Add an agent</button>} />
```

Don't: a line of grey text instead; more than one action.

## Status

A state in a small pill: a dot and a word or two. `tone`: `ok` (green), `running` (blue, its dot beats), `waiting`
(amber, on you), `review` (violet), `bad` (red), `off` (grey). `children` are the words; `title?` for more on hover.

```tsx
<Status tone="waiting">Waiting on you</Status>
```

Do: words that say it without the colour. Don't: colour for anything that isn't a state.

## More

"How this works": one line closed, its words open. `summary?` (the line, "How this works" by default), `children`,
`open?`. A `Section`'s `more` is this.

```tsx
<More><p>A new listener starts in Watch: the hub says what it would file and files nothing, until you turn it On.</p></More>
```

## MenuButton

The rare actions of a thing, behind a ⋯ (`aria-haspopup="menu"`, `aria-expanded` while open). It opens the app's own
menu (`components/ContextMenu.tsx`) under it: arrow keys, Escape back to the button, and a question before what can't be
undone (an item's `confirm`).

`items` (`MenuItem[]`, or a function that makes them when it opens), `label` (its name and hover: "More for Support
mail"), `className?`.

```tsx
<MenuButton label={`More for ${listener.name}`} items={[
  { label: 'New secret', icon: <KeyRound size={14} />, onSelect: renew },
  { separator: true },
  { label: 'Remove', danger: true, confirm: 'Remove it? Press again', onSelect: remove },
]} />
```

## Skeleton

Grey bars in the shape of what's coming, shimmering unless less motion was asked for; hidden from a screen reader (say
it's loading on what holds it). `width?`, `height?` (12), `lines?`, `round?`, `className?`.

```tsx
<Skeleton lines={3} />
```

---

## Base classes

Restyled once, so every screen has them. Use them; don't restyle them in a screen's own file.

- **Buttons**: `.button` (secondary), `.button.primary`, `.button.quiet` (no frame until hovered), `.button.danger`,
  `.button.danger.primary` (a destructive main action), `.button.small` (28), `.button.big` (44), `.mini-button` (looks
  like `.button.small`). `.icon-button` (32 square; give it `aria-label`, and `data-tip` with the same words for a hover
  label), `.text-button` (words that act, in a line).
- **Fields**: `.field` with `.field-label` (sentence case, 13px, over the box) and `.field-hint`; the boxes are any
  `input`, `select`, `textarea` in a `.field`, or `.input`, `.select`, `.textarea` on their own. `aria-invalid="true"`
  turns the frame red. `.eyebrow` is the rare small-capitals line.
- **Choices**: `.switch` (`<label className="switch"><input type="checkbox" /><span />Words</label>`), `.segmented`
  (buttons with `.on`, `aria-pressed` or `aria-checked`), `.tabs` (underline tabs; buttons or links with
  `aria-pressed`, `aria-selected` or `aria-current="page"`), `.check` for a checkbox or radio with its words.
- **Small facts**: `.chip` (a pill, `.chip.green` and the other tones with an `<i />` dot), `.tag` (squarer, a repo or
  a skill), `<Status>`.
- **Over the page**: `.dialog` (through `Dialog`), `.scrim`, `.toast` (through `toast()` and `failure()`),
  `.context-menu` (through `openMenu`, `openMenuUnder`, `MenuButton`).
