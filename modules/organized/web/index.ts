import type { WebModule } from '../../../web/modules.js';
import { Host, demoRequested } from './Host.js';
import { isList } from './screens.js';

export const module: WebModule = {
  id: 'organized',
  takesOver: boot => boot.extensions.some(e => e.id === 'organized') && (boot.layout === 'organized' || demoRequested()),
  chatBeside: (page, wide) => wide && (isList(page as never) || page === 'project'),
  Host,
};
