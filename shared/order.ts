/** The position that puts a row at index among rows already in order (their positions, ascending, without the moved row):
 *  halfway between its new neighbours, one past the last, one before the first, or 1 in an empty list. */
export function positionAt(positions: readonly number[], index: number): number {
  const before = positions[index - 1], after = positions[index];
  return before !== undefined && after !== undefined ? (before + after) / 2 : before !== undefined ? before + 1 : after !== undefined ? after - 1 : 1;
}
