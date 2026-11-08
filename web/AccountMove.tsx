import type { ManagerHome } from '../shared/contract.js';
import { useEffect, useState } from 'react';
import { api } from './client.js';
import { bridge, call } from './native.js';

/** Account movement is explicit; merely keeping one's manager on another channel does not move the app. */
export function AccountMove({ origin, accountId }: { origin: string; accountId: string }) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true, started = false;
    const native = bridge();
    const move = async () => {
      // An older APK must first install its ordinary automatic update: it cannot safely move its device connection.
      if (native && !(native as unknown as { accountMove?: boolean }).accountMove) return;
      if (started) return;
      started = true;
      try {
        const ticket = await api<{ origin: string; token: string; accountId: string } | null>('/account-move', 'POST', {});
        if (!current || !ticket) return;
        if (ticket.origin !== origin || ticket.accountId !== accountId) throw new Error('Account destination changed. Reopen the app.');
        if (native) {
          const result = await call('moveAccount', ticket);
          if (!result.ok) throw new Error(result.error.message);
        } else {
          // No credential in navigation URLs, browser history, referrers or local storage.
          const form = document.createElement('form');
          form.method = 'POST'; form.action = origin + '/api/account-arrive';
          for (const [name, value] of Object.entries({ token: ticket.token, next: location.pathname + location.search + location.hash })) {
            const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
          }
          document.body.append(form); form.submit();
        }
      } catch (e) { started = false; if (current) setError(e instanceof Error ? e.message : 'Could not connect to the new account host.'); }
    };
    void move();
    // The native capability may be installed after the first streamed bootstrap.
    const ready = () => { void move(); };
    window.addEventListener('kenan-native-ready', ready);
    return () => { current = false; window.removeEventListener('kenan-native-ready', ready); };
  }, [origin, accountId, attempt]);
  return <div className="update-banner" role="status"><span>{error || (bridge() && !(bridge() as unknown as { accountMove?: boolean }).accountMove ? 'Your account has moved. The Android app will connect after its automatic update.' : 'Connecting your account to its new home…')}</span><a className="primary" href={origin + '/'} target="_self">Open your moved account</a>{error && <button onClick={() => { setError(''); setAttempt(n => n + 1); }}>Retry</button>}</div>;
}

export function ManagerBanner({ home, origin, accountId }: { home: ManagerHome; origin?: string; accountId: string }) {
  if (origin) return <AccountMove origin={origin} accountId={accountId}/>;
  switch (home.kind) {
    case 'here': return null;
    case 'elsewhere': return <div className="update-banner" role="status"><span>Your Kenaznia answers in the other Kenan app.</span><a className="primary" href={home.url} target="_self">Open it</a></div>;
    case 'none': return <div className="update-banner" role="status"><span>No Kenaznia is set up for you yet. Ask whoever runs this server to add one.</span></div>;
  }
}
