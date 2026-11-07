// Reports the chat actually being read. Background, unfocused and native-paused windows never suppress notifications.
// The server forgets a report after 75 s, so it repeats every 30 s while the chat stays open.
import { useEffect } from 'react';
import { apiPath } from './path.js';
import { bridge } from './native.js';

const screen = Math.random().toString(36).slice(2);
let sequence = 0;

/** chat: the conversation on screen, including the person's own Kenaznia chat. */
export function useViewing(chat: string | null): void {
  useEffect(() => {
    if (!chat) return;
    let shown: string | null = chat, focused = document.hasFocus(), leaving = false;
    const send = () => void fetch(apiPath('/api/viewing'), {
      method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ screen, sequence: ++sequence, conversationId: !leaving && focused && document.visibilityState === 'visible' && bridge()?.foreground !== false ? shown : null }),
    }).catch(() => {});
    const focus = () => { focused = true; send(); };
    const blur = () => { focused = false; send(); };
    const hide = () => { leaving = true; send(); };
    const show = () => { leaving = false; focused = document.hasFocus(); send(); };
    const listeners: [EventTarget, string, () => void][] = [
      [document, 'visibilitychange', send], [window, 'focus', focus], [window, 'blur', blur],
      [window, 'pagehide', hide], [window, 'pageshow', show],
      [window, 'kenan-app-visibility', send], [window, 'kenan-native-ready', send],
    ];
    send();
    const timer = setInterval(send, 30_000);
    for (const [target, event, listener] of listeners) target.addEventListener(event, listener);
    return () => {
      clearInterval(timer);
      for (const [target, event, listener] of listeners) target.removeEventListener(event, listener);
      shown = null; send();
    };
  }, [chat]);
}
