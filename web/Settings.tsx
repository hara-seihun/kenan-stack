// The rarely changed settings behind ⚙ (web/CompactMenu.tsx), in their own chunk: the first open never downloads them.
import { TRAY_TILES, type TrayTile } from '../shared/contract.js';
import type { PushState } from './push.js';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './client.js';

export type Push = { state: PushState; enable(): void; disable(): void };
export type SettingsProps = {
  name: string | null; signOut(): void; /** A module's own rows, shown after the account line. */ extra?: ReactNode;
  skyMotion: { followsSystem: boolean; toggle(): void } | null; push: Push; checkUpdate: (() => void) | null;
  tray: { tiles: TrayTile[] | null; choose(tiles: TrayTile[] | null): void };
};

/** `name` set shows the account line (name and Sign out) first. */
export default function Settings(p: SettingsProps) {
  return <>
    {p.name !== null && <div className="cm-account"><span>{p.name}</span><button onClick={p.signOut}>Sign out</button></div>}
    {p.extra}
    {p.skyMotion && <Row label="Background motion" value={p.skyMotion.followsSystem ? 'Follows system' : 'Always'} onClick={p.skyMotion.toggle}/>}
    <TrayRows {...p.tray}/>
    <PushRow {...p.push}/>
    <QuietHours/>
    <Channels/>
    {p.checkUpdate ? <Row label="Check for app update" value={null} onClick={p.checkUpdate}/> : !/iPhone|iPad/.test(navigator.userAgent) && <Row label="Install Android app" value="/app.apk" onClick={() => { location.href = '/app.apk'; }}/>}
  </>;
}

function Row({ label, value, onClick, title, disabled }: { label: string; value: string | null; onClick(): void; title?: string | undefined; disabled?: boolean }) {
  return <button className="cm-row" title={title} disabled={disabled} onClick={onClick}><span>{label}</span>{value !== null && <small>{value}</small>}</button>;
}

const TRAY_NAMES: Record<TrayTile, string> = { calendar: 'Calendar', todo: 'To-do', search: 'Search', goals: 'Goals', usage: 'Usage', news: "What's new", finder: 'forest', sky: 'Sky' };

/** Which tiles the footer tray shows, kept on the account (PUT /api/tray): a switch per tile, then the default list. */
function TrayRows({ tiles, choose }: { tiles: TrayTile[] | null; choose(tiles: TrayTile[] | null): void }) {
  const shown = tiles ?? TRAY_TILES;
  return <>
    <div className="cm-line"><span>Tray icons</span></div>
    <div className="cm-tray">{TRAY_TILES.map(t => {
      const on = shown.includes(t);
      return <button key={t} className="cm-row" role="switch" aria-checked={on} onClick={() => choose(on ? shown.filter(x => x !== t) : [...shown, t])}><span>{TRAY_NAMES[t]}</span><small>{on ? 'Shown' : 'Hidden'}</small></button>;
    })}</div>
    {tiles && <Row label="Tray icons: back to default" value={null} onClick={() => choose(null)}/>}
  </>;
}

/** This device's Web Push; the Android app (no Push API) shows nothing. */
function PushRow({ state, enable, disable }: Push) {
  if (state.kind === 'unsupported') return null;
  const rows: Record<Exclude<PushState['kind'], 'unsupported'>, [string, () => void]> = {
    'install-first': ['Add to Home Screen first', () => alert('To get notifications on this iPhone: tap Share, then Add to Home Screen, open Kenan from the home screen, sign in, and tap Settings › Notifications here.')],
    denied: ['Blocked', () => alert('Notifications are blocked for Kenan. Allow them in Settings › Notifications › Kenan, then reopen the app.')],
    checking: ['…', () => {}], off: ['Off', enable], working: ['…', () => {}], on: ['On', disable], failed: ['Failed, retry', enable],
  };
  const [value, onClick] = rows[state.kind];
  return <Row label="Notifications here" value={value} onClick={onClick} disabled={state.kind === 'working' || state.kind === 'checking'} title={state.kind === 'failed' ? state.message : undefined}/>;
}

type QuietHoursSettings = { enabled: boolean; start: string; end: string; timeZone: string; active: boolean };

function QuietHours() {
  const [saved, setSaved] = useState<QuietHoursSettings | null>(null);
  const [draft, setDraft] = useState<QuietHoursSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api<QuietHoursSettings>('/quiet-hours').then(value => { setSaved(value); setDraft(value); }, e => setError(String(e.message ?? e)));
  };
  useEffect(load, []);
  const dirty = saved && draft && (saved.enabled !== draft.enabled || saved.start !== draft.start || saved.end !== draft.end);
  return <form onSubmit={event => {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true); setError(null);
    api<QuietHoursSettings>('/quiet-hours', 'PUT', { enabled: draft.enabled, start: draft.start, end: draft.end })
      .then(value => { setSaved(value); setDraft(value); }, e => setError(String(e.message ?? e))).finally(() => setBusy(false));
  }}>
    <div className="cm-line"><span>Quiet hours</span>{draft && <input type="checkbox" role="switch" aria-label="Enable quiet hours" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.currentTarget.checked })}/>}</div>
    {draft ? <>
      <label className="cm-row"><span>Start</span><input type="time" required aria-label="Quiet hours start" value={draft.start} disabled={busy} onChange={event => setDraft({ ...draft, start: event.currentTarget.value })} style={{ marginLeft: 'auto', minWidth: 0 }}/></label>
      <label className="cm-row"><span>End</span><input type="time" required aria-label="Quiet hours end" value={draft.end} disabled={busy} onChange={event => setDraft({ ...draft, end: event.currentTarget.value })} style={{ marginLeft: 'auto', minWidth: 0 }}/></label>
      <div className="cm-row"><small>Follows phone time zone · {draft.timeZone}</small></div>
      <button className="cm-row" type="submit" disabled={busy || !dirty}><span>{busy ? 'Saving…' : dirty ? 'Save quiet hours' : 'Quiet hours saved'}</span>{!dirty && <small>{saved?.active ? 'Active now' : saved?.enabled ? 'Scheduled' : 'Off'}</small>}</button>
    </> : !error && <div className="cm-row" role="status">Loading quiet hours…</div>}
    {error && <div className="cm-row" role="alert"><span>{error}</span>{!draft && <button type="button" onClick={load}>Retry</button>}</div>}
  </form>;
}

type Mode = 'direct' | 'filtered' | 'addressed' | 'off';
type ChannelSettings = { configured: boolean; platforms: { platform: string; mode: Mode; choices: Mode[] }[]; overrides: { channel: string; mode: Mode }[] };
const PLATFORM_NAMES: Record<string, string> = { kenan: 'Shared chats', signal: 'Signal', discord: 'Discord', mail: 'Mail', texts: 'Texts to Kenan' };
const MODE_NAMES: Record<Mode, string> = { direct: 'Straight to Kenaznia', filtered: 'Watcher decides', addressed: 'When addressed', off: 'Off' };

/** Where each platform's incoming messages go (server/channels/settings.ts); a tap moves a platform to its next mode.
 *  Shown only to someone with channel settings. */
function Channels() {
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<ChannelSettings>('/ext/channels/settings').then(setSettings, () => setSettings(null)); }, []);
  if (!settings?.configured) return null;
  const change = (channel: string, mode: Mode | null) => {
    setBusy(true);
    api<ChannelSettings>('/ext/channels/settings', 'PUT', { channel, mode }).then(setSettings, e => alert(String((e as Error).message ?? e))).finally(() => setBusy(false));
  };
  return <>
    <div className="cm-line"><span>Incoming messages</span></div>
    {settings.platforms.map(({ platform, mode, choices }) => <Row key={platform} label={PLATFORM_NAMES[platform] ?? platform} value={MODE_NAMES[mode]} disabled={busy}
      onClick={() => change(`${platform}:`, choices[(choices.indexOf(mode) + 1) % choices.length]!)}/>)}
    {settings.overrides.filter(o => !o.channel.endsWith(':')).map(o => <Row key={o.channel} label={o.channel} value={`${MODE_NAMES[o.mode]} · tap to remove`} disabled={busy} onClick={() => change(o.channel, null)}/>)}
  </>;
}
