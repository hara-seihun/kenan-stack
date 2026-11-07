// The Organized layout as the app shell hosts it: this module's own state (chat groups, the next trip, the layout and tip
// calls, demo mode) around the screens in Organized.tsx.
import { useEffect, useState } from 'react';
import type { ChatGroup, ChatGroupInput, Layout, Mark, Onboarding } from '../../../shared/contract.js';
import { api } from '../../../web/client.js';
import type { HostProps } from '../../../web/modules.js';
import { Organized, type GroupActions } from './Organized.js';
import { quickChat } from './quick.js';
import type { Screen, Trip } from './screens.js';

export const demoRequested = () => new URLSearchParams(location.search).get('demo') === '1';

/** The next calendar event whose title starts with ✈️; its place is what follows the last " to " (or the rest of the title). */
export function nextTripOf(events: { title: string; start: string }[]): Trip | null {
  const trip = events.filter(e => e.title.trim().startsWith('✈️')).map(e => ({ at: Date.parse(e.start), title: e.title.trim().slice(2).trim() })).filter(e => Number.isFinite(e.at)).sort((a, b) => a.at - b.at)[0];
  if (!trip) return null;
  const to = trip.title.lastIndexOf(' to ');
  return { at: trip.at, place: to >= 0 ? trip.title.slice(to + 4).trim() : trip.title };
}

export function Host(p: HostProps) {
  const { boot, setBoot, setPage, showError } = p;
  const [groups, setGroups] = useState<ChatGroup[] | null>(null);
  const [nextTrip, setNextTrip] = useState<Trip | null>(null);
  const demo = demoRequested();
  // Her first screen is Home, unless a shared link or an update resume already chose the place.
  useEffect(() => { if (!p.keepPlace || demo) setPage('home'); }, []);
  useEffect(() => {
    const load = () => {
      void api<ChatGroup[]>('/ext/organized/groups').then(setGroups).catch(showError);
      if (!boot.extensions.some(e => e.id === 'calendar')) return;
      const from = new Date().toISOString(), to = new Date(Date.now() + 120 * 86_400_000).toISOString();
      void api<{ title: string; start: string }[]>(`/ext/calendar/?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, 'GET', undefined, { background: true }).then(events => setNextTrip(nextTripOf(events)), showError);
    };
    const groupsChanged = (event: Event) => setGroups((event as CustomEvent<ChatGroup[]>).detail);
    load();
    window.addEventListener('kenan-refresh', load);
    window.addEventListener('kenan-chat-groups', groupsChanged);
    return () => { window.removeEventListener('kenan-refresh', load); window.removeEventListener('kenan-chat-groups', groupsChanged); };
  }, []);
  const groupsApi: GroupActions = {
    async create(input: ChatGroupInput) { try { const g = await api<ChatGroup>('/ext/organized/groups', 'POST', input); setGroups(c => c && [...c.filter(x => x.id !== g.id), g]); return g; } catch (e) { showError(e); return null; } },
    async change(id: string, patch: Partial<ChatGroupInput>) { try { const g = await api<ChatGroup>(`/ext/organized/groups/${encodeURIComponent(id)}`, 'PATCH', patch); setGroups(c => c && c.map(x => x.id === g.id ? g : x)); } catch (e) { showError(e); } },
    async remove(id: string) { try { const r = await api<{ conversationIds: string[] }>(`/ext/organized/groups/${encodeURIComponent(id)}`, 'DELETE'); setGroups(c => c && c.filter(x => x.id !== id)); return r.conversationIds; } catch (e) { showError(e); return null; } },
  };
  async function chooseLayout(layout: Layout) {
    try {
      const value = await api<Layout>('/ext/organized/layout', 'PUT', { layout });
      setBoot(current => current && ({ ...current, layout: value }));
      setPage(value === 'organized' ? 'home' : 'chat');
    } catch (e) { showError(e); }
  }
  async function seeTip(tip: Mark) {
    setBoot(current => current && ({ ...current, seen: current.seen.includes(tip) ? current.seen : [...current.seen, tip] }));
    try { const seen = await api<Onboarding[]>('/ext/organized/seen', 'POST', { tip }); setBoot(current => current && ({ ...current, seen })); }
    catch (e) { showError(e); }
  }
  function leaveDemo() {
    const url = new URL(location.href);
    url.searchParams.delete('demo');
    location.replace(url);
  }
  return <Organized boot={boot} goals={p.goals} todos={p.todos} todo={p.todo} buy={p.buy} setBuy={p.setBuy} groups={groups} groupsApi={groupsApi}
    screen={p.page as Screen} go={next => { p.go(next); }} active={p.active} open={p.open} openProject={p.openProject}
    detail={page => p.detail(page)} banners={p.banners} push={p.push} wide={p.wide} connected={p.connected}
    setLayout={layout => void chooseLayout(layout)} seeTip={tip => void seeTip(tip)} skyMotion={p.skyMotion}
    checkUpdate={p.checkUpdate} chooseTray={p.chooseTray} signOut={p.signOut} weeklyLeft={p.weeklyLeft} refreshUsage={p.refreshUsage}
    added={p.added} update={p.update} leave={p.leave} showClosed={p.showClosed} closedLoaded={p.closedLoaded} nextTrip={nextTrip}
    demo={demo} leaveDemo={leaveDemo} quick={quickChat(boot, p.history, p.setHistory, p.loadMessages as never, setBoot, p.drafts)} showSky={p.showSky} blank={p.blank}/>;
}
