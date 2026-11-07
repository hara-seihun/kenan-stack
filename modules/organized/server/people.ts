import type { PersonConfig, ServerConfig } from '../../../server/config.js';
/** The people of this channel who have the Organized module. */
export const hasOrganized = (person: PersonConfig): boolean => person.extensions.includes('organized');
export const organizedPeople = (config: Pick<ServerConfig, 'people'>): PersonConfig[] => config.people.filter(hasOrganized);
