import { shoppingFetchInputSchema, shoppingSearchInputSchema, productOfferSchema, eventsFetchInputSchema, eventsSearchInputSchema, eventAvailabilitySchema, type ConversationMessage, type ConversationThread, type EventAvailability, type Listing, type ProductOffer } from './domain.js';
import type { EventsBackend, ShoppingBackend } from './backend.js';
import { canonicalHttpUrl } from './backend.js';

export const FIXTURE_CONVERSATIONS: readonly {
  thread: ConversationThread;
  messages: ConversationMessage[];
}[] = [
  {
    thread: {
      thread_id: 't-synth-0001',
      participants: ['Synthetic Seller'],
      preview: 'Is the bike still available?',
      item_id: 'fixture-bike-001'
    },
    messages: [
      { sender: 'other', sender_name: 'Synthetic Seller', text: 'Is the bike still available?', sent_at: '2025-03-06T10:00:00.000Z' },
      { sender: 'you', text: 'Yes, it is available.', sent_at: '2025-03-06T10:05:00.000Z' },
      { sender: 'other', sender_name: 'Synthetic Seller', text: 'Could I see it this weekend?', sent_at: '2025-03-06T10:10:00.000Z' }
    ]
  },
  {
    thread: {
      thread_id: 't-synth-0002',
      participants: ['Synthetic Buyer'],
      preview: 'Would you consider a lower price?'
    },
    messages: [
      { sender: 'you', text: 'Thanks for your interest.', sent_at: '2025-03-07T14:00:00.000Z' },
      { sender: 'other', sender_name: 'Synthetic Buyer', text: 'Would you consider a lower price?', sent_at: '2025-03-07T14:05:00.000Z' }
    ]
  },
  {
    thread: {
      thread_id: 't-synth-0003',
      participants: ['Synthetic Seller'],
      preview: 'I can pick up the chairs tomorrow.',
      item_id: 'fixture-chair-002'
    },
    messages: [
      { sender: 'other', sender_name: 'Synthetic Seller', text: 'I can pick up the chairs tomorrow.', sent_at: '2025-03-08T09:00:00.000Z' },
      { sender: 'you', text: 'Tomorrow works for me.', sent_at: '2025-03-08T09:10:00.000Z' }
    ]
  }
];

export const FIXTURE_OFFERS: readonly ProductOffer[] = [
  {
    provider: 'ebay', id: 'synth-solar-001', product_id: null,
    url: 'https://www.example.com/ebay/item/synth-solar-001', title: 'SYNTHETIC 100W solar panel demo offer',
    price: 42, currency: 'USD', condition: 'new', availability: 'in_stock', shipping_cost: 8, shipping_currency: 'USD',
    location: 'Synthetic warehouse', seller: { id: 'seller-synth-1', name: 'Synthetic Seller' },
    posted_at: '2025-01-01T00:00:00.000Z', updated_at: null, images: [], state: 'active'
  },
  {
    provider: 'ebay', id: 'synth-battery-002', product_id: 'product-synth-2',
    url: 'https://www.example.com/ebay/item/synth-battery-002', title: 'SYNTHETIC 12V battery sample',
    price: 19, currency: 'USD', condition: 'used', availability: 'in_stock', shipping_cost: null, shipping_currency: null,
    location: null, seller: null, posted_at: null, updated_at: null, images: [], state: 'active'
  },
  {
    provider: 'ebay', id: 'synth-meter-003', product_id: null,
    url: 'https://www.example.com/ebay/item/synth-meter-003', title: 'SYNTHETIC digital multimeter example',
    price: 0, currency: 'USD', condition: 'refurbished', availability: 'unknown', shipping_cost: 0, shipping_currency: 'USD',
    location: 'Example location', seller: { name: 'Demo Seller' },
    posted_at: null, updated_at: null, images: [], state: 'unknown'
  },
  {
    provider: 'ebay', id: 'synth-panel-004', product_id: null,
    url: 'https://www.example.com/ebay/item/synth-panel-004', title: 'SYNTHETIC compact solar panel',
    price: null, currency: 'USD', condition: 'unknown', availability: 'out_of_stock', shipping_cost: null, shipping_currency: null,
    location: null, seller: null, posted_at: null, updated_at: null, images: [], state: 'sold'
  },
  {
    provider: 'ebay', id: 'synth-battery-005', product_id: 'product-synth-5',
    url: 'https://www.example.com/ebay/item/synth-battery-005', title: 'SYNTHETIC rechargeable battery pack',
    price: 73, currency: 'USD', condition: 'new', availability: 'preorder', shipping_cost: 4, shipping_currency: 'USD',
    location: 'Demo depot', seller: { name: 'Sample Store' },
    posted_at: null, updated_at: null, images: [], state: 'pending'
  },
  {
    provider: 'ebay', id: 'synth-meter-006', product_id: null,
    url: 'https://www.example.com/ebay/item/synth-meter-006', title: 'SYNTHETIC multimeter calibration unit',
    price: 28, currency: 'USD', condition: 'used', availability: 'in_stock', shipping_cost: 2, shipping_currency: 'USD',
    location: null, seller: null, posted_at: null, updated_at: null, images: [], state: 'active'
  }
].map((offer) => productOfferSchema.parse(offer));

export class FixtureShoppingBackend implements ShoppingBackend {
  readonly name = 'fixture';

  search(input: ReturnType<typeof shoppingSearchInputSchema.parse>, _signal: AbortSignal): ProductOffer[] {
    const query = input.query.toLowerCase();
    return FIXTURE_OFFERS.filter((offer) => {
      const matchesText = offer.title.toLowerCase().includes(query);
      const matchesMin = input.min_price === undefined || (offer.price !== null && offer.price >= input.min_price);
      const matchesMax = input.max_price === undefined || (offer.price !== null && offer.price <= input.max_price);
      return matchesText && matchesMin && matchesMax;
    }).slice(0, input.limit);
  }

  fetch(input: ReturnType<typeof shoppingFetchInputSchema.parse>, _signal: AbortSignal): ProductOffer | null {
    if (input.id !== undefined) return FIXTURE_OFFERS.find((offer) => offer.id === input.id) ?? null;
    const target = canonicalHttpUrl(input.url!);
    return FIXTURE_OFFERS.find((offer) => canonicalHttpUrl(offer.url) === target) ?? null;
  }
}

export const FIXTURE_EVENTS: readonly EventAvailability[] = [
  {
    provider: 'ticketmaster', id: 'synth-event-001',
    url: 'https://example.com/events/synth-event-001', name: 'SYNTHETIC Evening Orchestra',
    starts_at: '2025-06-01T19:30:00.000Z', timezone: 'America/Los_Angeles',
    status: 'on_sale', price_min: 25, price_max: 95, currency: 'USD',
    venue: 'Synthetic Concert Hall', location: 'Portland, US',
    on_sale_start: '2025-03-01T17:00:00.000Z', on_sale_end: '2025-06-01T18:00:00.000Z',
    classifications: ['Music', 'Classical'], images: ['https://example.com/images/synth-event-001-a.jpg', 'https://example.com/images/synth-event-001-b.jpg']
  },
  {
    provider: 'ticketmaster', id: 'synth-event-002',
    url: 'https://example.com/events/synth-event-002', name: 'SYNTHETIC Comedy Night',
    starts_at: null, timezone: null,
    status: 'off_sale', price_min: 30, price_max: null, currency: 'USD',
    venue: 'Synthetic Comedy Club', location: 'Seattle, US',
    on_sale_start: null, on_sale_end: null,
    classifications: ['Arts & Theatre'], images: []
  },
  {
    provider: 'ticketmaster', id: 'synth-event-003',
    url: 'https://example.com/events/synth-event-003', name: 'SYNTHETIC Stadium Final',
    starts_at: '2025-07-15T02:00:00.000Z', timezone: 'America/New_York',
    status: 'sold_out', price_min: null, price_max: null, currency: null,
    venue: null, location: null,
    on_sale_start: null, on_sale_end: null,
    classifications: [], images: []
  },
  {
    provider: 'ticketmaster', id: 'synth-event-004',
    url: 'https://example.com/events/synth-event-004', name: 'SYNTHETIC Cancelled Matinee',
    starts_at: null, timezone: null,
    status: 'cancelled', price_min: null, price_max: null, currency: null,
    venue: 'Synthetic Theatre', location: 'Portland, US',
    on_sale_start: null, on_sale_end: null,
    classifications: [], images: []
  },
  {
    provider: 'ticketmaster', id: 'synth-event-005',
    url: 'https://example.com/events/synth-event-005', name: 'SYNTHETIC Postponed Festival',
    starts_at: '2025-08-20T18:00:00.000Z', timezone: 'America/Chicago',
    status: 'postponed', price_min: 55, price_max: 150, currency: 'USD',
    venue: 'Synthetic Fairgrounds', location: 'Chicago, US',
    on_sale_start: '2025-04-01T15:00:00.000Z', on_sale_end: null,
    classifications: ['Music', 'Festival'], images: ['https://example.com/images/synth-event-005.jpg']
  },
  {
    provider: 'ticketmaster', id: 'synth-event-006',
    url: 'https://example.com/events/synth-event-006', name: 'SYNTHETIC Gallery Opening',
    starts_at: '2025-05-10T23:00:00.000Z', timezone: 'Europe/London',
    status: 'unknown', price_min: null, price_max: null, currency: null,
    venue: null, location: 'London, GB',
    on_sale_start: null, on_sale_end: null,
    classifications: ['Arts & Theatre', 'Fine Art'], images: []
  }
].map((event) => eventAvailabilitySchema.parse(event));

export class FixtureEventsBackend implements EventsBackend {
  readonly name = 'fixture';

  search(input: ReturnType<typeof eventsSearchInputSchema.parse>, _signal: AbortSignal): EventAvailability[] {
    const query = input.query.toLowerCase();
    const city = input.city?.toLowerCase();
    return FIXTURE_EVENTS.filter((event) => {
      const matchesText = event.name.toLowerCase().includes(query);
      const matchesCity = city === undefined || (event.location !== null && event.location.toLowerCase().includes(city));
      const startsOn = event.starts_at === null ? null : event.starts_at.slice(0, 10);
      const matchesStart = input.start_date === undefined || (startsOn !== null && startsOn >= input.start_date);
      const matchesEnd = input.end_date === undefined || (startsOn !== null && startsOn <= input.end_date);
      return matchesText && matchesCity && matchesStart && matchesEnd;
    }).slice(0, input.limit);
  }

  fetch(input: ReturnType<typeof eventsFetchInputSchema.parse>, _signal: AbortSignal): EventAvailability | null {
    if (input.id !== undefined) return FIXTURE_EVENTS.find((event) => event.id === input.id) ?? null;
    const target = canonicalHttpUrl(input.url!);
    return FIXTURE_EVENTS.find((event) => canonicalHttpUrl(event.url) === target) ?? null;
  }
}

export const FIXTURE_LISTINGS: readonly Listing[] = [
  {
    id: 'fixture-bike-001',
    url: 'https://example.com/marketplace/listing/fixture-bike-001',
    title: 'Vintage road bike',
    price: 240,
    currency: 'USD',
    location: 'Portland, OR',
    posted_at: '2025-03-04T10:00:00.000Z',
    updated_at: '2025-03-05T12:30:00.000Z',
    description: 'Steel frame road bike, tuned and ready to ride. Synthetic fixture listing.',
    images: ['https://example.com/images/fixture-bike-001.jpg'],
    seller: { id: 'fixture-seller-01', name: 'Fixture Seller' },
    state: 'active'
  },
  {
    id: 'fixture-chair-002',
    url: 'https://example.com/marketplace/listing/fixture-chair-002',
    title: 'Pair of oak dining chairs',
    price: 80,
    currency: 'USD',
    location: 'Seattle, WA',
    posted_at: '2025-02-10T09:15:00.000Z',
    updated_at: null,
    description: 'Two solid oak chairs with a few marks from use. Synthetic fixture listing.',
    images: ['https://example.com/images/fixture-chair-002.jpg'],
    seller: null,
    state: 'pending'
  },
  {
    id: 'fixture-camera-003',
    url: 'https://example.com/marketplace/listing/fixture-camera-003',
    title: '35mm film camera',
    price: null,
    currency: 'USD',
    location: 'Portland, OR',
    posted_at: '2025-01-28T16:45:00.000Z',
    updated_at: null,
    description: 'Mechanical film camera; message for details. Synthetic fixture listing.',
    images: [],
    seller: null,
    state: 'unknown'
  },
  {
    id: 'fixture-lamp-004',
    url: 'https://example.com/marketplace/listing/fixture-lamp-004',
    title: 'Mid-century desk lamp',
    price: 35,
    currency: 'USD',
    location: 'Portland, OR',
    posted_at: '2024-12-12T08:00:00.000Z',
    updated_at: '2025-01-03T14:00:00.000Z',
    seller: null,
    description: 'Small brass desk lamp in working condition. Synthetic fixture listing.',
    images: ['https://example.com/images/fixture-lamp-004.jpg'],
    state: 'sold'
  },
  {
    id: 'fixture-shelf-005',
    url: 'https://example.com/marketplace/listing/fixture-shelf-005',
    title: 'Pine bookshelf',
    price: 55,
    currency: 'USD',
    location: 'Tacoma, WA',
    posted_at: '2025-03-11T11:20:00.000Z',
    updated_at: null,
    description: 'Five-shelf pine bookcase with adjustable shelves. Synthetic fixture listing.',
    images: ['https://example.com/images/fixture-shelf-005.jpg'],
    seller: { name: 'Example Seller', url: 'https://example.com/sellers/fixture-seller-05' },
    state: 'active'
  },
  {
    id: 'fixture-sofa-006',
    url: 'https://example.com/marketplace/listing/fixture-sofa-006',
    title: 'Blue two-seat sofa',
    price: 325,
    currency: 'USD',
    location: 'Eugene, OR',
    posted_at: '2025-03-18T13:00:00.000Z',
    updated_at: null,
    seller: null,
    description: 'Compact blue fabric sofa, smoke-free home. Synthetic fixture listing.',
    images: [],
    state: 'removed'
  }
];
