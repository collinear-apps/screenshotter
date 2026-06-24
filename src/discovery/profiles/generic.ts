// Owned by Wave 1 / Agent C (discovery).
import type { Profile } from '../../types';
import { crawl } from '../crawler';

export const genericProfile: Profile = {
  name: 'generic',
  matches: () => true,
  discover: async (context, cfg) => crawl(context, cfg),
};
