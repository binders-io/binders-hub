/** Which Binder something belongs to: its initial and name, small, beside the thing's own name. */
export function BinderTag({ name }: { name: string }) {
  return (
    <span className="binder-tag" title={`Registered to the binder ${name}`}>
      <i aria-hidden="true">{name.charAt(0).toUpperCase()}</i>
      {name}
    </span>
  )
}
