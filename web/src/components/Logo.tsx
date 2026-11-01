/**
 * The Binders mark in the text colour: a page with two rings, black on white or white on black with the theme.
 * Inverted, the tile takes the background with an outline and the page takes the text colour.
 */
export function Logo({ size = 42, inverted = false }: { size?: number; inverted?: boolean }) {
  const tile = inverted ? 'var(--bg)' : 'var(--text)'
  const page = inverted ? 'var(--text)' : 'var(--bg)'
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="1" y="1" width="62" height="62" rx="15" fill={tile} stroke={inverted ? 'var(--text)' : 'none'} strokeWidth={inverted ? 2 : 0} />
      <rect x="20" y="12" width="29" height="40" rx="4.5" fill={page} />
      <rect x="27" y="21" width="15" height="3.2" rx="1.6" fill={tile} />
      <rect x="27" y="28.5" width="13" height="3.2" rx="1.6" fill={tile} />
      <rect x="27" y="36" width="9" height="3.2" rx="1.6" fill={tile} />
      <circle cx="20" cy="23" r="4.6" fill={page} stroke={tile} strokeWidth="2.6" />
      <circle cx="20" cy="41" r="4.6" fill={page} stroke={tile} strokeWidth="2.6" />
    </svg>
  )
}
