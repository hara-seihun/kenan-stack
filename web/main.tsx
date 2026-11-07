import React, { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { apiPath } from './path.js';
import { recoverApp } from './recover.js';
import { installNotificationClearing } from './push.js';
import { installLinks } from './links.js';
import './styles.css';

/** A screen this build can't draw (usually saved state from another build) reloads the newest build once; if that
 *  happens again within a minute, the error is shown with a Reload button instead of a blank page. */
class Recovering extends Component<{ children: ReactNode }, { failure: string | null }> {
  state = { failure: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { failure: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(error: unknown) {
    if (recoverApp(`render: ${error instanceof Error ? error.stack ?? error.message : String(error)}`).kind === 'exhausted') document.documentElement.dataset.appStarted = 'true';
  }
  render() {
    if (this.state.failure === null) return this.props.children;
    return <main className="login"><p role="alert">Kenan hit an error: {this.state.failure}</p><button onClick={() => location.reload()}>Reload</button></main>;
  }
}

installLinks();
installNotificationClearing();
let codeCopy: Promise<typeof import('./codeCopy.js')> | null = null;
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'contextmenu']) document.addEventListener(type, e => {
  if (e.target instanceof Element && e.target.closest('.code-block')) void (codeCopy ??= import('./codeCopy.js')).then(m => m.handle(e), console.warn);
}, true);
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
if ((navigator as Navigator & { standalone?: boolean }).standalone === true) void import('./viewport.js').then(m => m.installStandaloneViewport(), console.warn);
createRoot(root).render(<React.StrictMode><Recovering><App/></Recovering></React.StrictMode>);
// The service worker keeps the app shell on the device so the next open starts without the network.
if ('serviceWorker' in navigator) window.addEventListener('load', () => {
  navigator.serviceWorker.register(apiPath('/sw.js'), { scope: apiPath('/') }).catch(e => console.warn('Service worker registration failed:', e));
});
