export function isAllowedRequest(host: string | undefined, origin: string | undefined, port: number): boolean {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !hosts.includes(host)) return false;
  return origin === undefined || hosts.some((h) => origin === `http://${h}`);
}
