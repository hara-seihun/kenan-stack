const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/** Whether a text field has focus, which is when a phone shows its keyboard. */
export function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) || (el instanceof HTMLElement && el.isContentEditable);
}
