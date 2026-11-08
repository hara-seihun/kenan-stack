// The 🛒 To buy tab's pure parts (web/todo/ToBuy.tsx): the rows a section shows, what a drop changes, and the demo list.
import type { BuyItem, BuyList, BuySection } from '../../shared/contract.js';
import { positionAt } from '../../shared/order.js';
import type { DropSpot } from './rowDrag.js';

export type DemoState = { sections: BuySection[]; items: (BuyItem & { gone: boolean })[] };
export function demoList(): DemoState {
  const sections: BuySection[] = [
    { id: 'demo-s-1', name: 'Groceries', emoji: '🥕', color: '#9bc53d', position: 1 },
    { id: 'demo-s-2', name: 'Things', emoji: '🧰', color: '#5b7fd0', position: 2 },
    { id: 'demo-s-3', name: 'Amazon', emoji: '📦', color: '#c03b8f', position: 3 },
  ];
  const rows: [string, string[]][] = [['demo-s-1', ['Soap', 'Milk', 'Eggs', 'Oat bread']], ['demo-s-2', ['Scissors', 'Toilet paper', 'Light bulbs']], ['demo-s-3', ['Phone charger (USB-C)', 'Violin rosin']]];
  return { sections, items: rows.flatMap(([sectionId, texts]) => texts.map((text, i) => ({ id: `${sectionId}-${i}`, sectionId, text, position: i + 1, boughtAt: null, gone: false }))) };
}
/** The rows a section shows: its open items, plus the ones just bought that are still fading out, in list order. */
export function sectionRows(list: BuyList, leaving: readonly BuyItem[], sectionId: string): { item: BuyItem; fading: boolean }[] {
  const open = list.items.filter(i => i.sectionId === sectionId).map(item => ({ item, fading: false }));
  const fading = leaving.filter(i => i.sectionId === sectionId && !open.some(o => o.item.id === i.id)).map(item => ({ item, fading: true }));
  return [...open, ...fading].sort((a, b) => a.item.position - b.item.position);
}


/** The change dropping an item at a spot makes and the change that undoes it; null when it lands where it already is. */
export function buyDropPlan(list: BuyList, item: BuyItem, to: DropSpot<string>): { patch: { sectionId: string; position: number }; undo: { sectionId: string; position: number } } | null {
  const here = list.items.filter(i => i.sectionId === to.section);
  if (item.sectionId === to.section && here.findIndex(i => i.id === item.id) === to.index) return null;
  const rows = here.filter(i => i.id !== item.id);
  return { patch: { sectionId: to.section, position: positionAt(rows.map(i => i.position), Math.min(to.index, rows.length)) }, undo: { sectionId: item.sectionId, position: item.position } };
}
