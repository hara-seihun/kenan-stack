import React, { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { apiPath } from './path.js';
import { recoverApp } from './recover.js';
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

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<React.StrictMode><Recovering><App/></Recovering></React.StrictMode>);
// The service worker keeps the app shell on the device so the next open starts without the network.
if ('serviceWorker' in navigator) window.addEventListener('load', () => {
  navigator.serviceWorker.register(apiPath('/sw.js'), { scope: apiPath('/') }).catch(e => console.warn('Service worker registration failed:', e));
});
