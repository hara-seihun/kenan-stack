// The Android app's KenanNext bridge (its WebView injects it on Kenan's own origin): one request, one reply by id.
export type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };
type Bridge = { nativeNotifications?: boolean; foreground?: boolean; postMessage(data: string): void; addEventListener(type: 'message', listener: (event: { data: string }) => void): void };

export const bridge = (): Bridge | null => (window as unknown as { KenanNext?: Bridge }).KenanNext ?? null;
const pending = new Map<string, (outcome: Outcome) => void>();
let listening = false;

export function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
  const native = bridge();
  if (!native) return Promise.resolve({ ok: false, error: { code: 'unsupported', message: 'Not running in the Android app' } });
  if (!listening) {
    listening = true;
    native.addEventListener('message', event => {
      const reply = JSON.parse(event.data) as { id: string | null; result: Outcome };
      if (reply.id) { pending.get(reply.id)?.(reply.result); pending.delete(reply.id); }
    });
  }
  const id = crypto.randomUUID();
  return new Promise(resolve => { pending.set(id, resolve); native.postMessage(JSON.stringify({ id, name, args })); });
}
