// lucide-react's icons render through this instead of its createLucideIcon (build/preact.ts aliases it): the same SVG
// for the props the app uses (size, className, fill, aria-*), without its context, class merging and a11y runtime,
// which cost ~1 kB of the startup budget.
import { createElement, type SVGAttributes } from 'react';

type IconData = { name: string; node: [string, Record<string, string>][] };
type Props = SVGAttributes<SVGSVGElement> & { size?: number | string };

export default function createLucideIcon(data: IconData) {
  return ({ size = 24, className, ...rest }: Props) => createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': rest['aria-label'] ? undefined : 'true',
    ...rest, className: ['lucide', `lucide-${data.name}`, className].filter(Boolean).join(' '),
  }, data.node.map(([tag, attrs]) => createElement(tag, attrs)));
}
