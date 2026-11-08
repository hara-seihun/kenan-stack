// Intl formatters are expensive to build (toLocaleTimeString builds one per call); every display format is built once.
const formatters = new Map<string, Intl.DateTimeFormat>();

/** `at` (epoch ms or Date) in the device's locale and zone, like `toLocale…String([], options)`. */
export function formatDate(at: number | Date, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let format = formatters.get(key);
  if (!format) { format = new Intl.DateTimeFormat([], options); formatters.set(key, format); }
  return format.format(at);
}

/** YYYY-MM-DD in the device's current zone. Date's local fields need no Intl formatter or zone-name lookup per row. */
export function localDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
