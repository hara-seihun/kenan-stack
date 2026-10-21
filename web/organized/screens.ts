// Screen names shared by the app shell and the lazily loaded Organized layout.
export type ListScreen = 'home' | 'chats' | 'activity' | 'todo';
export type DetailScreen = 'chat' | 'calendar' | 'goals' | 'usage' | 'project';
export type Screen = ListScreen | DetailScreen;
export const isList = (s: Screen): s is ListScreen => s === 'home' || s === 'chats' || s === 'activity' || s === 'todo';
export interface Trip { at: number; place: string }
