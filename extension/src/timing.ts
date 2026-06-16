export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const sleepUntil = (perfTime: number): Promise<void> =>
  sleep(perfTime - performance.now());

export const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);

export const smooth = (t: number): number => t * t * (3 - 2 * t);

export function log(msg: string) {
  console.log(`[agentcursor] ${msg}`);
}
