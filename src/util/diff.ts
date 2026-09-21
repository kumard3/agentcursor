/**
 * Line-level diff of two reads. Refs are stable, so an unchanged element gives
 * an identical line. Elements that only moved (a layout shift, a scroll) are
 * counted rather than listed, since their ref still points at the same thing.
 */
export function diffRead(previous: string[], next: string[]): string {
  const pending = new Map<string, string[]>();
  for (const line of previous) {
    const list = pending.get(key(line));
    if (list) list.push(line);
    else pending.set(key(line), [line]);
  }

  const added: string[] = [];
  let moved = 0;
  let unchanged = 0;
  for (const line of next) {
    const list = pending.get(key(line));
    const match = list?.shift();
    if (match === undefined) added.push(line);
    else if (match === line) unchanged++;
    else moved++;
  }
  const removed = [...pending.values()].flat();

  if (!added.length && !removed.length && !moved) return "no change since the last read";
  const summary = `(${moved ? `${moved} moved, ` : ""}${unchanged} unchanged, ${next.length} total)`;
  return [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`), summary].join("\n");
}

/** The line without its centre point, so a moved element still matches itself. */
function key(line: string): string {
  return line.replace(/ @-?\d+,-?\d+/, "");
}

/** The diff, or the full read when it is not smaller or there is nothing to compare against. */
export function readOrDiff(previous: string[] | undefined, next: string[]): string {
  const full = next.join("\n");
  if (!previous) return full;
  const diff = diffRead(previous, next);
  return diff.length < full.length ? diff : full;
}
