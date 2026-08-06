import {
  getRunStats,
  getResearchStats,
  getListingStats,
  getOfferStats,
  getMessageStats,
  listDropshipOrders,
} from '../lib/db.js';
import { summary as booksSummary } from './books.js';

export function build({ sinceDays = 7 } = {}) {
  return {
    runs: getRunStats({ sinceDays }),
    research: getResearchStats(),
    listings: getListingStats(),
    offers: getOfferStats(),
    messages: getMessageStats(),
    books: booksSummary(),
    pendingDropship: listDropshipOrders({ status: 'needs_ordering' }),
  };
}
