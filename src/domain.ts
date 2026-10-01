import { z } from 'zod';

export const SCHEMA_VERSION = '1.0.0';
export const SERVICE_VERSION = '0.1.0';
export const MAX_QUERY_LENGTH = 256;
export const MAX_LOCATION_LENGTH = 256;
export const MAX_LISTING_ID_LENGTH = 128;
export const MAX_BACKEND_NAME_LENGTH = 64;
export const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 256;
export const MAX_PROVIDER_ACTION_LENGTH = 128;

export const PROVIDER_ERROR_CODES = [
  'AUTH_EXPIRED',
  'LOGIN_REQUIRED',
  'CAPTCHA_REQUIRED',
  'SESSION_INVALID',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'TIMEOUT'
] as const;

export const backendNameSchema = z.string().min(1).max(MAX_BACKEND_NAME_LENGTH).regex(/\S/);

const httpUrlSchema = z.string().max(2048).url().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s/@]+(?:[/?#][^\s]*)?$/).meta({ format: 'uri' }).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Must be an HTTP(S) URL');

const isoDateTimeSchema = z.string().datetime({ offset: true });

export const sellerSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  url: httpUrlSchema.optional()
}).strict();

export const listingSchema = z.object({
  id: z.string().min(1).max(MAX_LISTING_ID_LENGTH),
  url: httpUrlSchema,
  title: z.string().min(1).max(256),
  price: z.number().finite().nonnegative().nullable(),
  currency: z.string().min(1).max(3),
  location: z.string().min(1).max(MAX_LOCATION_LENGTH),
  posted_at: isoDateTimeSchema.nullable(),
  updated_at: isoDateTimeSchema.nullable(),
  description: z.string().max(280),
  images: z.array(httpUrlSchema).max(6),
  seller: sellerSchema.nullable(),
  state: z.enum(['active', 'sold', 'pending', 'removed', 'unknown'])
}).strict();

export type Listing = z.infer<typeof listingSchema>;

export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH).regex(/\S/),
  location: z.string().trim().min(1).max(MAX_LOCATION_LENGTH).regex(/\S/),
  min_price: z.number().finite().nonnegative().optional(),
  max_price: z.number().finite().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).default(5)
}).strict().refine((input) => {
  return input.min_price === undefined || input.max_price === undefined || input.min_price <= input.max_price;
}, { message: 'min_price must be less than or equal to max_price', path: ['max_price'] });

export const fetchInputSchema = z.object({
  id: z.string().min(1).max(MAX_LISTING_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  url: httpUrlSchema.optional()
}).strict().refine((input) => Number(input.id !== undefined) + Number(input.url !== undefined) === 1, {
  message: 'Provide exactly one of id or url'
});

export const statusInputSchema = z.object({}).strict();

export const runtimeErrorCodeSchema = z.enum([
  ...PROVIDER_ERROR_CODES,
  'NOT_FOUND',
  'INTERNAL_ERROR'
]);

export const providerErrorMetadataSchema = z.object({
  action_required: z.string().min(1).max(MAX_PROVIDER_ACTION_LENGTH).optional(),
  login_url: httpUrlSchema.optional(),
  retry_after: z.number().int().nonnegative().optional()
}).strict();

export const providerErrorSchema = z.object({
  code: z.enum(PROVIDER_ERROR_CODES),
  message: z.string().min(1).max(MAX_PROVIDER_ERROR_MESSAGE_LENGTH),
  ...providerErrorMetadataSchema.shape
}).strict();

const runtimeErrorSchema = z.object({
  code: runtimeErrorCodeSchema,
  message: z.string().min(1).max(MAX_PROVIDER_ERROR_MESSAGE_LENGTH),
  ...providerErrorMetadataSchema.shape
}).strict();

export const runtimeFailureSchema = z.object({
  ok: z.literal(false),
  error: runtimeErrorSchema
}).strict();

export const searchSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  listings: z.array(listingSchema).max(20)
}).strict();

export const fetchSuccessSchema = z.object({
  ok: z.literal(true),
  backend: backendNameSchema,
  listing: listingSchema
}).strict();

export const statusSuccessSchema = z.object({
  ok: z.literal(true),
  service_version: z.literal(SERVICE_VERSION),
  schema_version: z.literal(SCHEMA_VERSION),
  backend: backendNameSchema
}).strict();

export const searchOutputSchema = z.union([searchSuccessSchema, runtimeFailureSchema]);
export const fetchOutputSchema = z.union([fetchSuccessSchema, runtimeFailureSchema]);
export const statusOutputSchema = statusSuccessSchema;
export type RuntimeFailure = z.infer<typeof runtimeFailureSchema>;
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];
export type ProviderErrorMetadata = z.infer<typeof providerErrorMetadataSchema>;
