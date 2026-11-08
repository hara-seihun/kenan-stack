import type { Module } from '../../../server/modules.js';
import { changelogExtension } from './changelog.js';
import { bubbleExtension, busyLineExtension, organizedExtension } from './organized.js';
import { organizedRoutesByChat } from './routing.js';
import { roomsAddition, todosAddition } from './tools.js';

export const module: Module = {
  id: 'organized',
  extensions: [organizedExtension, bubbleExtension, busyLineExtension, changelogExtension],
  additions: { todos: todosAddition, rooms: roomsAddition },
  routesByChat: organizedRoutesByChat,
};
