/** Loaded only in iOS home-screen web apps (navigator.standalone). There WebKit sometimes reports the viewport short: on an
 *  iPhone 15 Pro Max (iOS 26, status bar style black) innerHeight, visualViewport, 100dvh and 100svh are 737 pt from
 *  launch and 100lvh 848, while the web view is 873 pt tall, so a 100dvh shell ended 136 pt above the bottom with a
 *  black band under the composer. A position:fixed box with inset:0 does reach the bottom, so while no text field has
 *  focus the shell is that box. While one has focus the shell is back in flow at WebKit's own height, which is what
 *  keeps the composer above the keyboard. */

import { typing } from './typing.js';

export type Shell = 'screen' | 'viewport';

export function installStandaloneViewport(): () => void {
  const html = document.documentElement;
  const apply = (shell: Shell) => html.classList.toggle('shell-screen', shell === 'screen');
  const settle = () => apply(typing() ? 'viewport' : 'screen');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => { if (timer !== null) clearTimeout(timer); timer = setTimeout(() => { timer = null; settle(); }, 150); };
  const focusin = () => { if (typing()) apply('viewport'); };
  addEventListener('resize', later);
  document.addEventListener('focusin', focusin);
  document.addEventListener('focusout', later);
  settle();
  return () => {
    if (timer !== null) clearTimeout(timer);
    removeEventListener('resize', later);
    document.removeEventListener('focusin', focusin);
    document.removeEventListener('focusout', later);
    html.classList.remove('shell-screen');
  };
}
