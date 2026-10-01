import type { Listing } from './domain.js';

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
