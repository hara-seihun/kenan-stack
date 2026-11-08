// The sidebar footer's icons. Its own chunk: the SVGs are ~1.5 kB and the footer paints without them.
import { useId } from 'react';
import { Search } from 'lucide-react';
import { footerIcons, type FooterIconId as GeneratedIconId } from './footerIcons.generated.js';

export type FooterIconId = GeneratedIconId | 'search';

/** A footer icon; each instance gets its own gradient and filter ids, since the nav and the ☰ sheet can both be in the page. */
export default function FooterIcon({ id }: { id: FooterIconId }) {
  const prefix = `fi${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const svg = (footerIcons as Partial<Record<FooterIconId, string>>)[id];
  if (!svg) return <Search size={24} aria-hidden="true"/>;
  return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg.replaceAll('@', prefix) }}/>;
}
