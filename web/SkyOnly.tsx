// The background on its own (Alice, 2026-10-26: "press a button and I can just see the background"): everything else
// on the page is hidden and the art shows at full strength. A tap anywhere, Back or Escape returns to the app.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from './overlay.js';

export default function SkyOnly({ close }: { close(): void }) {
  useOverlay(true, close);
  useEffect(() => {
    document.documentElement.classList.add('sky-only');
    return () => document.documentElement.classList.remove('sky-only');
  }, []);
  return createPortal(<button className="sky-only-exit" aria-label="Back to the app" onClick={close}><span>Tap anywhere to go back</span></button>, document.body);
}
