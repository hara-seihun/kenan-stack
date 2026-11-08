// Every link click in the app goes through one decision, made before the browser's default action:
// - A link to another site opens in a new browsing context (target=_blank, rel=noopener noreferrer). In a Safari tab
//   that is a new tab; in a standalone web app (iOS home screen, macOS Dock) and the Android app it is the default
//   browser. It never replaces the app, which would lose the open chat (Dave 2026-10-22: a github.com link in a
//   message took over the Dock app's window).
// - In the Android app a link to one of our files would load the file in place of the app, and Back would then leave
//   the app. There, a file link downloads instead (the app saves it), and the page stays exactly where it was.
// - Any other link (same origin, or one that names its own target) keeps its in-app behaviour.
import { apiPath } from './path.js';

export type LinkAction = 'app' | 'external' | { download: string };

/** What a click on `href` from `page` does: open another site outside the app, download one of our files (Android app), or stay in the app. */
export function linkAction(href: string, page: string, filesPath: string, androidApp: boolean): LinkAction {
  const url = new URL(href, page);
  if (url.origin !== new URL(page).origin) return /^https?:$/.test(url.protocol) ? 'external' : 'app';
  if (!androidApp || !url.pathname.startsWith(filesPath) || url.searchParams.has('download')) return 'app';
  url.searchParams.set('download', '1');
  return { download: url.href };
}

export function installLinks(): void {
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download') || event.defaultPrevented) return;
    const action = linkAction(link.href, location.href, apiPath('/api/files/'), 'KenanNext' in window);
    if (action === 'external') {
      if (!link.target) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    } else if (action !== 'app') {
      event.preventDefault();
      location.assign(action.download);
    }
  }, true);
}
