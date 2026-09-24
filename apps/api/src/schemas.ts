import { z } from '@hono/zod-openapi';
import {
  ART_SCOPES,
  ART_STATUSES,
  IMAGE_CONTENT_TYPES,
  OVERFLIGHT_STATUSES,
  POSTER_STATUSES,
  QUALIFICATION_REASONS,
  isValidTimeZone,
} from '@overhead/core';
import type { Json } from '@overhead/database';
import { DISPLAY_LIMITS, EXCLUSION_REASONS } from '@overhead/display';

const uuid = z.string().uuid();
const ts = z.string().openapi({ format: 'date-time' });
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
const httpUrl = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/, 'must be an http(s) URL');
const timezone = z.string().max(64).refine(isValidTimeZone, 'must be an IANA time zone');
const registration = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,12}$/);
const typeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,4}$/);
const operatorIcao = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);
// JSON object column. Typed as Supabase's Json record; documented as a free-form object.
const jsonObject = z.record(z.string(), z.unknown()) as unknown as z.ZodType<{
  [key: string]: Json;
}>;
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export const profileSchema = z
  .object({
    id: uuid,
    display_name: z.string().nullable(),
    timezone: z.string(),
    created_at: ts,
    updated_at: ts,
  })
  .openapi('Profile');
export const profileUpdateSchema = z
  .object({ display_name: nullableText(100).optional(), timezone: timezone.optional() })
  .strict();

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
export const LOCATION_SUMMARY_COLUMNS =
  'id,name,search_radius_nm,overhead_radius_m,max_altitude_ft,timezone,is_active,created_at,updated_at';
export const LOCATION_COLUMNS = `${LOCATION_SUMMARY_COLUMNS},latitude,longitude`;

export const locationSummarySchema = z
  .object({
    id: uuid,
    name: z.string(),
    search_radius_nm: z.number(),
    overhead_radius_m: z.number().int(),
    max_altitude_ft: z.number().int(),
    timezone: z.string(),
    is_active: z.boolean(),
    created_at: ts,
    updated_at: ts,
  })
  .openapi('LocationSummary', { description: 'Location without coordinates (list view).' });

export const locationSchema = locationSummarySchema
  .extend({ latitude: z.number(), longitude: z.number() })
  .openapi('Location', { description: 'Full location record including private coordinates.' });

const locationFields = {
  name: z.string().trim().min(1).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  search_radius_nm: z.number().positive().max(250),
  overhead_radius_m: z.number().int().positive().max(50_000),
  max_altitude_ft: z.number().int().positive().max(60_000),
  timezone,
  is_active: z.boolean(),
};

export const locationCreateSchema = z
  .object({
    ...locationFields,
    search_radius_nm: locationFields.search_radius_nm.optional(),
    overhead_radius_m: locationFields.overhead_radius_m.optional(),
    max_altitude_ft: locationFields.max_altitude_ft.optional(),
    timezone: locationFields.timezone.optional(),
    is_active: locationFields.is_active.optional(),
  })
  .strict()
  .openapi('LocationCreate');

export const locationUpdateSchema = z
  .object(locationFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('LocationUpdate');

// ---------------------------------------------------------------------------
// Aircraft
// ---------------------------------------------------------------------------
export const AIRCRAFT_COLUMNS =
  'id,icao24,registration,icao_type_code,manufacturer,family,model,variant,operator_name,operator_icao,operator_iata,country,metadata_source,raw_metadata,created_at,updated_at';

export const aircraftSchema = z
  .object({
    id: uuid,
    icao24: z.string(),
    registration: z.string().nullable(),
    icao_type_code: z.string().nullable(),
    manufacturer: z.string().nullable(),
    family: z.string().nullable(),
    model: z.string().nullable(),
    variant: z.string().nullable(),
    operator_name: z.string().nullable(),
    operator_icao: z.string().nullable(),
    operator_iata: z.string().nullable(),
    country: z.string().nullable(),
    metadata_source: z.string().nullable(),
    raw_metadata: jsonObject,
    created_at: ts,
    updated_at: ts,
  })
  .openapi('Aircraft');

export const aircraftUpdateSchema = z
  .object({
    registration: registration.nullable(),
    icao_type_code: typeCode.nullable(),
    manufacturer: nullableText(120),
    family: nullableText(120),
    model: nullableText(120),
    variant: nullableText(120),
    operator_name: nullableText(160),
    operator_icao: operatorIcao.nullable(),
    operator_iata: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2}$/)
      .nullable(),
    country: nullableText(80),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('AircraftUpdate');

export const aircraftQuerySchema = z.object({
  registration: z.string().trim().max(12).optional(),
  icao24: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^~?[0-9a-f]{6}$/)
    .optional(),
  type_code: typeCode.optional(),
  manufacturer: z.string().trim().min(1).max(60).optional(),
  model: z.string().trim().min(1).max(60).optional(),
});

// ---------------------------------------------------------------------------
// Overflights
// ---------------------------------------------------------------------------
export const OVERFLIGHT_COLUMNS =
  'id,location_id,aircraft_id,provider,icao24,registration,callsign,flight_number,origin_code,destination_code,first_seen_at,closest_seen_at,last_seen_at,local_date,minimum_distance_m,minimum_altitude_ft,closest_altitude_ft,heading,status,qualification_reason,created_at';

const embeddedAircraft = z
  .object({
    icao_type_code: z.string().nullable(),
    operator_icao: z.string().nullable(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
  })
  .nullable();

export const overflightSchema = z
  .object({
    id: uuid,
    location_id: uuid,
    aircraft_id: uuid.nullable(),
    provider: z.string(),
    icao24: z.string(),
    registration: z.string().nullable(),
    callsign: z.string().nullable(),
    flight_number: z.string().nullable(),
    origin_code: z.string().nullable(),
    destination_code: z.string().nullable(),
    first_seen_at: ts,
    closest_seen_at: ts,
    last_seen_at: ts,
    local_date: z.string(),
    minimum_distance_m: z.number(),
    minimum_altitude_ft: z.number().int().nullable(),
    closest_altitude_ft: z.number().int().nullable(),
    heading: z.number().nullable(),
    status: z.enum(OVERFLIGHT_STATUSES),
    qualification_reason: z.enum(QUALIFICATION_REASONS),
    created_at: ts,
    aircraft: embeddedAircraft.optional(),
  })
  .openapi('Overflight');

export const overflightDetailSchema = overflightSchema
  .extend({
    provider_pass_key: z.string(),
    raw_summary: jsonObject,
    closest_latitude: z.number().nullable().optional(),
    closest_longitude: z.number().nullable().optional(),
  })
  .openapi('OverflightDetail');

export const overflightQuerySchema = z.object({
  location_id: uuid.optional(),
  from: localDate.optional().openapi({ description: 'Local date (inclusive), YYYY-MM-DD' }),
  to: localDate.optional().openapi({ description: 'Local date (inclusive), YYYY-MM-DD' }),
  registration: registration.optional(),
  type_code: typeCode.optional(),
  operator: operatorIcao.optional(),
  status: z.enum(OVERFLIGHT_STATUSES).optional(),
});

export const overflightPointSchema = z
  .object({
    observed_at: ts,
    latitude: z.number(),
    longitude: z.number(),
    altitude_ft: z.number().int().nullable(),
    groundspeed_knots: z.number().nullable(),
    track_degrees: z.number().nullable(),
    source: z.enum(['provider', 'closest_approach']),
  })
  .openapi('OverflightPoint');

// ---------------------------------------------------------------------------
// Hangar
// ---------------------------------------------------------------------------
export const HANGAR_COLUMNS =
  'aircraft_id,icao24,registration,icao_type_code,manufacturer,model,operator_name,operator_icao,first_seen_at,last_seen_at,pass_count,qualified_pass_count,closest_distance_m,lowest_altitude_ft,closest_overflight_id,best_art_asset_id,best_art_scope,has_artwork';

export const hangarEntrySchema = z
  .object({
    aircraft_id: uuid,
    icao24: z.string(),
    registration: z.string().nullable(),
    icao_type_code: z.string().nullable(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    operator_name: z.string().nullable(),
    operator_icao: z.string().nullable(),
    first_seen_at: ts,
    last_seen_at: ts,
    pass_count: z.number().int(),
    qualified_pass_count: z.number().int(),
    closest_distance_m: z.number(),
    lowest_altitude_ft: z.number().int().nullable(),
    closest_overflight_id: uuid,
    best_art_asset_id: uuid.nullable(),
    best_art_scope: z.enum(ART_SCOPES).nullable(),
    has_artwork: z.boolean(),
  })
  .openapi('HangarEntry');

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------
export const imageUploadRequestSchema = z
  .object({
    filename: z.string().min(1).max(200),
    content_type: z.enum(Object.keys(IMAGE_CONTENT_TYPES) as [keyof typeof IMAGE_CONTENT_TYPES]),
  })
  .strict()
  .openapi('ImageUploadRequest');

export const uploadUrlSchema = z
  .object({
    bucket: z.string(),
    path: z.string(),
    signed_url: z.string(),
    token: z.string(),
    expires_in_seconds: z.number().int(),
  })
  .openapi('SignedUpload', {
    description: 'Upload with PUT to signed_url (or uploadToSignedUrl).',
  });

// ---------------------------------------------------------------------------
// Source images
// ---------------------------------------------------------------------------
export const SOURCE_IMAGE_COLUMNS =
  'id,aircraft_id,source_provider,source_page_url,original_file_url,storage_path,creator,license_name,license_url,attribution_text,view_angle_score,identity_confidence,raw_metadata,created_at,updated_at';

export const sourceImageSchema = z
  .object({
    id: uuid,
    aircraft_id: uuid.nullable(),
    source_provider: z.string(),
    source_page_url: z.string().nullable(),
    original_file_url: z.string().nullable(),
    storage_path: z.string().nullable(),
    creator: z.string().nullable(),
    license_name: z.string().nullable(),
    license_url: z.string().nullable(),
    attribution_text: z.string().nullable(),
    view_angle_score: z.number().nullable(),
    identity_confidence: z.number().nullable(),
    raw_metadata: jsonObject,
    created_at: ts,
    updated_at: ts,
  })
  .openapi('SourceImage');

const sourceImageFields = {
  aircraft_id: uuid.nullable(),
  source_provider: z.string().trim().min(1).max(60),
  source_page_url: httpUrl.nullable(),
  original_file_url: httpUrl.nullable(),
  storage_path: z.string().max(300).nullable(),
  creator: z.string().max(200).nullable(),
  license_name: z.string().max(120).nullable(),
  license_url: httpUrl.nullable(),
  attribution_text: z.string().max(1000).nullable(),
  view_angle_score: z.number().min(0).max(1).nullable(),
  identity_confidence: z.number().min(0).max(1).nullable(),
  raw_metadata: jsonObject,
};

export const sourceImageCreateSchema = z
  .object(sourceImageFields)
  .partial()
  .required({ source_provider: true })
  .strict()
  .openapi('SourceImageCreate');

export const sourceImageUpdateSchema = z
  .object(sourceImageFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('SourceImageUpdate');

// ---------------------------------------------------------------------------
// Art assets
// ---------------------------------------------------------------------------
export const ART_ASSET_COLUMNS =
  'id,aircraft_id,icao_type_code,operator_icao,livery_name,registration,scope,status,source_image_id,storage_path,thumbnail_path,generation_provider,generation_model,generation_prompt,prompt_version,identity_confidence,reviewer_notes,approved_at,created_at,updated_at';

export const artAssetSchema = z
  .object({
    id: uuid,
    aircraft_id: uuid.nullable(),
    icao_type_code: z.string().nullable(),
    operator_icao: z.string().nullable(),
    livery_name: z.string().nullable(),
    registration: z.string().nullable(),
    scope: z.enum(ART_SCOPES),
    status: z.enum(ART_STATUSES),
    source_image_id: uuid.nullable(),
    storage_path: z.string(),
    thumbnail_path: z.string().nullable(),
    generation_provider: z.string().nullable(),
    generation_model: z.string().nullable(),
    generation_prompt: z.string().nullable(),
    prompt_version: z.string().nullable(),
    identity_confidence: z.number().nullable(),
    reviewer_notes: z.string().nullable(),
    approved_at: ts.nullable(),
    created_at: ts,
    updated_at: ts,
  })
  .openapi('ArtAsset');

const artFields = {
  aircraft_id: uuid.nullable(),
  icao_type_code: typeCode.nullable(),
  operator_icao: operatorIcao.nullable(),
  livery_name: nullableText(120),
  registration: registration.nullable(),
  scope: z.enum(ART_SCOPES),
  status: z.enum(['draft', 'pending_review', 'archived']),
  source_image_id: uuid.nullable(),
  storage_path: z.string().max(300),
  thumbnail_path: z.string().max(300).nullable(),
  generation_provider: z.string().max(60).nullable(),
  generation_model: z.string().max(120).nullable(),
  generation_prompt: z.string().max(8000).nullable(),
  prompt_version: z.string().max(40).nullable(),
  identity_confidence: z.number().min(0).max(1).nullable(),
  reviewer_notes: z.string().max(2000).nullable(),
};

export function artScopeProblem(v: {
  scope?: string;
  registration?: string | null;
  operator_icao?: string | null;
  icao_type_code?: string | null;
  livery_name?: string | null;
}): string | null {
  switch (v.scope) {
    case 'registration':
      return v.registration ? null : 'registration scope requires registration';
    case 'operator_livery':
      return v.operator_icao && v.icao_type_code && v.livery_name
        ? null
        : 'operator_livery scope requires operator_icao, icao_type_code and livery_name';
    case 'operator_type':
      return v.operator_icao && v.icao_type_code
        ? null
        : 'operator_type scope requires operator_icao and icao_type_code';
    case 'type':
      return v.icao_type_code ? null : 'type scope requires icao_type_code';
    default:
      return null;
  }
}

export const artAssetCreateSchema = z
  .object(artFields)
  .partial()
  .required({ scope: true, storage_path: true })
  .strict()
  .superRefine((v, ctx) => {
    const problem = artScopeProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['scope'] });
  })
  .openapi('ArtAssetCreate');

export const artAssetUpdateSchema = z
  .object(artFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('ArtAssetUpdate', { description: 'Use /approve and /reject to change review state.' });

export const artReviewSchema = z
  .object({ reviewer_notes: z.string().max(2000).nullable().optional() })
  .strict()
  .openapi('ArtReview');

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------
export const POSTER_COLUMNS =
  'id,location_id,local_date,template_version,status,full_color_preview_path,eink_preview_path,device_binary_path,binary_sha256,width,height,generated_at,error,created_at,updated_at';
export const POSTER_ITEM_COLUMNS =
  'id,poster_id,overflight_id,art_asset_id,display_order,rendered_labels,created_at,updated_at';

export const posterItemSchema = z
  .object({
    id: uuid,
    poster_id: uuid,
    overflight_id: uuid,
    art_asset_id: uuid.nullable(),
    display_order: z.number().int(),
    rendered_labels: jsonObject,
    created_at: ts,
    updated_at: ts,
  })
  .openapi('PosterItem');

export const posterSchema = z
  .object({
    id: uuid,
    location_id: uuid,
    local_date: z.string(),
    template_version: z.string(),
    status: z.enum(POSTER_STATUSES),
    full_color_preview_path: z.string().nullable(),
    eink_preview_path: z.string().nullable(),
    device_binary_path: z.string().nullable(),
    binary_sha256: z.string().nullable(),
    width: z.number().int(),
    height: z.number().int(),
    generated_at: ts.nullable(),
    error: z.string().nullable(),
    created_at: ts,
    updated_at: ts,
    items: z.array(posterItemSchema).optional(),
  })
  .openapi('Poster');

export const posterCreateSchema = z
  .object({
    location_id: uuid,
    local_date: localDate,
    template_version: z.string().trim().min(1).max(40),
    width: z.number().int().min(1).max(10_000).optional(),
    height: z.number().int().min(1).max(10_000).optional(),
  })
  .strict()
  .openapi('PosterCreate');

export const posterUpdateSchema = z
  .object({
    local_date: localDate,
    template_version: z.string().trim().min(1).max(40),
    status: z.enum(POSTER_STATUSES).openapi({
      description:
        'Setting "ready" verifies the uploaded device binary (size, pixel codes) and records its sha256.',
    }),
    full_color_preview_path: z.string().max(300).nullable(),
    eink_preview_path: z.string().max(300).nullable(),
    width: z.number().int().min(1).max(10_000),
    height: z.number().int().min(1).max(10_000),
    generated_at: ts.nullable(),
    error: z.string().max(2000).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('PosterUpdate');

export const posterItemsCreateSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            overflight_id: uuid,
            art_asset_id: uuid.nullable().optional(),
            display_order: z.number().int().min(0).max(1000),
            rendered_labels: jsonObject.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .openapi('PosterItemsCreate');

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
export const DEVICE_COLUMNS =
  'id,location_id,name,device_ref,mac_address,hardware_revision,firmware_version,battery_mv,rssi,last_boot_reason,last_seen_at,latest_poster_id,poll_interval_seconds,reset_requested,created_at,updated_at';

export const deviceSchema = z
  .object({
    id: uuid,
    location_id: uuid.nullable(),
    name: z.string(),
    device_ref: z.string(),
    mac_address: z.string(),
    hardware_revision: z.string().nullable(),
    firmware_version: z.string().nullable(),
    battery_mv: z.number().int().nullable(),
    rssi: z.number().int().nullable(),
    last_boot_reason: z.string().nullable(),
    last_seen_at: ts.nullable(),
    latest_poster_id: uuid.nullable(),
    poll_interval_seconds: z.number().int(),
    reset_requested: z.boolean(),
    created_at: ts,
    updated_at: ts,
    enrollment_state: z.enum(['pending', 'enrolled', 'revoked']).nullable().optional(),
    token_created_at: ts.nullable().optional(),
  })
  .openapi('Device');

export const deviceWithSecretSchema = z
  .object({
    device: deviceSchema,
    setup_secret: z.string().openapi({
      description:
        'Shown once. Enter as the BYOS setup secret during frame provisioning. Only its hash is stored.',
    }),
  })
  .openapi('DeviceWithSetupSecret');

export const deviceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    mac_address: z.string().trim().min(12).max(17),
    location_id: uuid.nullable().optional(),
    hardware_revision: z.string().trim().max(60).nullable().optional(),
    poll_interval_seconds: z.number().int().min(60).max(604_800).optional(),
  })
  .strict()
  .openapi('DeviceCreate');

export const deviceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    location_id: uuid.nullable(),
    latest_poster_id: uuid.nullable(),
    poll_interval_seconds: z.number().int().min(60).max(604_800),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('DeviceUpdate');

export const rotateSecretSchema = z
  .object({
    revoke_token: z
      .boolean()
      .optional()
      .openapi({ description: 'Also invalidate the current bearer token.' }),
  })
  .strict();

export const deletedSchema = z.object({ id: uuid, deleted: z.literal(true) }).openapi('Deleted');

// ---------------------------------------------------------------------------
// Admin board: users, frames and display selection
// ---------------------------------------------------------------------------
const weight = z.number().min(DISPLAY_LIMITS.weight.min).max(DISPLAY_LIMITS.weight.max);
const hour = z.number().int().min(DISPLAY_LIMITS.hour.min).max(DISPLAY_LIMITS.hour.max);
const bounded = (limits: { min: number; max: number }) =>
  z.number().int().min(limits.min).max(limits.max);

export const displayWeightsSchema = z
  .object({
    rarity: weight,
    proximity: weight,
    recency: weight,
    artwork: weight,
    detail: weight,
  })
  .openapi('DisplayWeights');

const displaySettingsFields = {
  max_planes: bounded(DISPLAY_LIMITS.max_planes),
  window_hours: bounded(DISPLAY_LIMITS.window_hours),
  min_dwell_minutes: bounded(DISPLAY_LIMITS.min_dwell_minutes),
  include_near_misses: z.boolean(),
  include_helicopters: z.boolean(),
  airline_only: z.boolean(),
  one_per_operator_type: z.boolean(),
  quiet_start_hour: hour.nullable(),
  quiet_end_hour: hour.nullable(),
};

export const displaySettingsSchema = z
  .object({ ...displaySettingsFields, weights: displayWeightsSchema })
  .openapi('DisplaySettings');

export const displaySettingsPatchSchema = z
  .object({ ...displaySettingsFields, weights: displayWeightsSchema.partial().strict() })
  .partial()
  .strict()
  .openapi('DisplaySettingsPatch', {
    description: 'Fields to change; omitted fields keep their current value.',
  });

export const artUrlsSchema = z
  .record(
    z.string(),
    z.object({ image_url: z.string().nullable(), thumbnail_url: z.string().nullable() }),
  )
  .openapi('ArtUrls', { description: 'Short-lived signed image links keyed by art asset id.' });

export const displayItemSchema = z
  .object({
    display_order: z.number().int(),
    overflight_id: uuid,
    registration: z.string().nullable(),
    callsign: z.string().nullable(),
    flight_number: z.string().nullable(),
    origin_code: z.string().nullable(),
    destination_code: z.string().nullable(),
    origin_name: z.string().nullable().optional(),
    destination_name: z.string().nullable().optional(),
    icao_type_code: z.string().nullable(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    operator_name: z.string().nullable(),
    operator_icao: z.string().nullable(),
    closest_seen_at: ts,
    closest_altitude_ft: z.number().nullable(),
    minimum_distance_m: z.number(),
    art_asset_id: uuid.nullable(),
    art_scope: z.enum(ART_SCOPES).nullable(),
    score: z.number(),
  })
  .openapi('DisplayItem', {
    description: 'One plane in a selection, as the renderer will receive it. No coordinates.',
  });

export const adminUserSchema = z
  .object({
    id: uuid,
    email: z.string().nullable(),
    display_name: z.string().nullable(),
    created_at: ts,
    last_sign_in_at: ts.nullable(),
    is_admin: z.boolean(),
    device_count: z.number().int(),
    location_count: z.number().int(),
    overflight_count: z.number().int(),
    last_overflight_at: ts.nullable(),
  })
  .openapi('AdminUser');

export const adminDeviceSchema = z
  .object({
    id: uuid,
    owner_id: uuid,
    owner_email: z.string().nullable(),
    name: z.string(),
    location_id: uuid.nullable(),
    location_name: z.string().nullable(),
    timezone: z.string().nullable(),
    poll_interval_seconds: z.number().int(),
    battery_mv: z.number().int().nullable(),
    rssi: z.number().int().nullable(),
    firmware_version: z.string().nullable(),
    last_boot_reason: z.string().nullable(),
    last_seen_at: ts.nullable(),
    created_at: ts,
    enrollment_state: z.string().nullable(),
    settings: displaySettingsSchema,
    has_custom_settings: z.boolean(),
    current_selection: z
      .object({ selected_at: ts, reason: z.string(), items: z.array(displayItemSchema) })
      .nullable(),
    selections_24h: z.number().int(),
  })
  .openapi('AdminDevice');

export const adminLocationSchema = z
  .object({
    id: uuid,
    owner_id: uuid,
    name: z.string(),
    timezone: z.string(),
    search_radius_nm: z.number(),
    overhead_radius_m: z.number().int(),
    max_altitude_ft: z.number().int(),
    is_active: z.boolean(),
  })
  .openapi('AdminLocation', { description: 'Location detection rules; never coordinates.' });

export const adminDeviceDetailSchema = z
  // A union, not .nullable(): that would mark the shared AdminLocation component nullable.
  .object({
    device: adminDeviceSchema,
    location: z.union([adminLocationSchema, z.null()]),
    art_urls: artUrlsSchema,
  })
  .openapi('AdminDeviceDetail');

export const adminDeviceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    poll_interval_seconds: z.number().int().min(60).max(604_800),
    location_id: uuid.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('AdminDeviceUpdate');

export const adminLocationUpdateSchema = z
  .object({
    search_radius_nm: locationFields.search_radius_nm,
    overhead_radius_m: locationFields.overhead_radius_m,
    max_altitude_ft: locationFields.max_altitude_ft,
    is_active: locationFields.is_active,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('AdminLocationUpdate');

export const adminSelectionSchema = z
  .object({
    id: uuid,
    selected_at: ts,
    reason: z.string(),
    items: z.array(displayItemSchema),
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi('DisplaySelection');

export const displayPreviewRequestSchema = z
  .object({
    settings: displaySettingsPatchSchema.optional(),
    poll_interval_seconds: z.number().int().min(60).max(604_800).optional(),
    at: z.iso
      .datetime()
      .optional()
      .openapi({ description: 'Evaluate as of this instant (default: now).' }),
  })
  .strict()
  .openapi('DisplayPreviewRequest');

export const scoredCandidateSchema = z
  .object({
    overflight_id: uuid,
    icao24: z.string(),
    registration: z.string().nullable(),
    callsign: z.string().nullable(),
    flight_number: z.string().nullable(),
    origin_code: z.string().nullable(),
    destination_code: z.string().nullable(),
    origin_name: z.string().nullable(),
    destination_name: z.string().nullable(),
    closest_seen_at: ts,
    status: z.enum(OVERFLIGHT_STATUSES),
    minimum_distance_m: z.number(),
    closest_altitude_ft: z.number().nullable(),
    icao_type_code: z.string().nullable(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    operator_name: z.string().nullable(),
    operator_icao: z.string().nullable(),
    aircraft_class: z.string().nullable(),
    art_asset_id: uuid.nullable(),
    art_scope: z.enum(ART_SCOPES).nullable(),
    airframe_sightings: z.number().int(),
    type_sightings: z.number().int().nullable(),
    score: z.number(),
    components: z.object({
      rarity: z.number(),
      proximity: z.number(),
      recency: z.number(),
      artwork: z.number(),
      detail: z.number(),
    }),
    excluded: z.enum(EXCLUSION_REASONS).nullable(),
  })
  .openapi('ScoredCandidate');

export const displayPreviewSchema = z
  .object({
    at: ts,
    settings: displaySettingsSchema,
    poll_interval_seconds: z.number().int(),
    timezone: z.string(),
    selected: z.array(displayItemSchema),
    candidates: z.array(scoredCandidateSchema),
    current_selection: z.object({ overflight_ids: z.array(uuid), selected_at: ts }).nullable(),
    decision: z.object({
      commit: z.boolean(),
      reason: z.enum(['initial', 'changed', 'unchanged', 'dwell', 'no_candidates']),
      hold_until: ts.optional(),
    }),
    wake_schedule: z.array(ts).openapi({ description: 'Next scheduled (timer) wakes.' }),
    art_urls: artUrlsSchema,
  })
  .openapi('DisplayPreview');

// ---------------------------------------------------------------------------
// Admin board: artwork, source images, posters, coverage
// ---------------------------------------------------------------------------
export const adminArtAssetSchema = z
  .object({
    id: uuid,
    owner_id: uuid,
    owner_email: z.string().nullable(),
    aircraft_id: uuid.nullable(),
    aircraft_registration: z.string().nullable(),
    icao_type_code: z.string().nullable(),
    operator_icao: z.string().nullable(),
    livery_name: z.string().nullable(),
    registration: z.string().nullable(),
    scope: z.enum(ART_SCOPES),
    status: z.enum(ART_STATUSES),
    source_image_id: uuid.nullable(),
    storage_path: z.string(),
    thumbnail_path: z.string().nullable(),
    generation_provider: z.string().nullable(),
    generation_model: z.string().nullable(),
    prompt_version: z.string().nullable(),
    identity_confidence: z.number().nullable(),
    reviewer_notes: z.string().nullable(),
    approved_at: ts.nullable(),
    created_at: ts,
    updated_at: ts,
    sightings_30d: z.number().int(),
    image_url: z.string().nullable(),
    thumbnail_url: z.string().nullable(),
  })
  .openapi('AdminArtAsset');

export const adminArtListSchema = z
  .object({
    items: z.array(adminArtAssetSchema),
    counts: z.record(z.string(), z.number().int()).openapi({ description: 'Assets per status.' }),
  })
  .openapi('AdminArtList');

const artTagFields = {
  scope: z.enum(ART_SCOPES),
  icao_type_code: typeCode.nullable(),
  operator_icao: operatorIcao.nullable(),
  livery_name: nullableText(120),
  registration: registration.nullable(),
  reviewer_notes: z.string().max(2000).nullable(),
};

export const adminArtUpdateSchema = z
  .object(artTagFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required')
  .openapi('AdminArtUpdate');

export const adminArtReviewSchema = z
  .object({
    status: z.enum(['approved', 'rejected', 'pending_review', 'archived']),
    reviewer_notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .openapi('AdminArtReview');

export const adminArtUploadRequestSchema = imageUploadRequestSchema
  .extend({ owner_id: uuid })
  .strict()
  .openapi('AdminArtUploadRequest');

export const adminArtCreateSchema = z
  .object({
    owner_id: uuid,
    storage_path: z.string().max(300),
    ...artTagFields,
    icao_type_code: artTagFields.icao_type_code.optional(),
    operator_icao: artTagFields.operator_icao.optional(),
    livery_name: artTagFields.livery_name.optional(),
    registration: artTagFields.registration.optional(),
    reviewer_notes: artTagFields.reviewer_notes.optional(),
    approve: z.boolean().optional().openapi({ description: 'Approve immediately after upload.' }),
  })
  .strict()
  .superRefine((v, ctx) => {
    const problem = artScopeProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['scope'] });
  })
  .openapi('AdminArtCreate');

export const adminSourceImageSchema = z
  .object({
    id: uuid,
    owner_id: uuid,
    owner_email: z.string().nullable(),
    aircraft_id: uuid.nullable(),
    aircraft_registration: z.string().nullable(),
    aircraft_type: z.string().nullable(),
    source_provider: z.string(),
    source_page_url: z.string().nullable(),
    original_file_url: z.string().nullable(),
    storage_path: z.string().nullable(),
    creator: z.string().nullable(),
    license_name: z.string().nullable(),
    license_url: z.string().nullable(),
    attribution_text: z.string().nullable(),
    view_angle_score: z.number().nullable(),
    identity_confidence: z.number().nullable(),
    created_at: ts,
    art_count: z.number().int(),
    image_url: z.string().nullable(),
  })
  .openapi('AdminSourceImage');

export const adminPosterSchema = z
  .object({
    id: uuid,
    owner_id: uuid,
    owner_email: z.string().nullable(),
    location_name: z.string().nullable(),
    local_date: z.string(),
    template_version: z.string(),
    status: z.string(),
    has_binary: z.boolean(),
    binary_verified: z.boolean(),
    generated_at: ts.nullable(),
    error: z.string().nullable(),
    created_at: ts,
    updated_at: ts,
    item_count: z.number().int(),
    pinned_on: z.array(z.string()),
    full_color_preview_url: z.string().nullable(),
    eink_preview_url: z.string().nullable(),
  })
  .openapi('AdminPoster');

export const coverageRowSchema = z
  .object({
    owner_id: uuid,
    owner_email: z.string().nullable(),
    operator_icao: z.string().nullable(),
    operator_name: z.string().nullable(),
    icao_type_code: z.string().nullable(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    sightings: z.number().int(),
    airframes: z.number().int(),
    last_seen_at: ts,
    best_scope: z.enum(ART_SCOPES).nullable(),
    best_art_asset_id: uuid.nullable(),
    best_thumbnail_url: z.string().nullable(),
    airframes_with_exact_art: z.number().int(),
    pending_count: z.number().int(),
  })
  .openapi('CoverageRow', {
    description:
      'Recorded passes grouped by operator + aircraft type, with the best artwork available.',
  });

export const seenAircraftSchema = z
  .object({
    icao24: z.string(),
    aircraft_id: uuid.nullable(),
    registration: z.string().nullable(),
    icao_type_code: z.string().nullable(),
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    operator_icao: z.string().nullable(),
    operator_name: z.string().nullable(),
    country: z.string().nullable(),
    passes: z.number().int(),
    users: z.number().int(),
    first_seen_at: ts,
    last_seen_at: ts,
    closest_distance_m: z.number(),
  })
  .openapi('SeenAircraft', { description: 'One airframe seen overhead in the period.' });

export const aircraftPhotoSchema = z
  .object({
    photo: z
      .object({
        thumbnail_url: z.string(),
        large_url: z.string(),
        page_url: z.string(),
        photographer: z.string(),
      })
      .nullable(),
  })
  .openapi('AircraftPhoto', {
    description:
      'A Planespotters.net photo of the airframe, or null when there is none. Show the ' +
      'photographer and link to page_url; hotlink the image, never store it.',
  });

export const seenAircraftReportSchema = z
  .object({
    passes: z.number().int(),
    airframes: z.number().int(),
    by_type: z.array(
      z.object({
        icao_type_code: z.string().nullable(),
        manufacturer: z.string().nullable(),
        model: z.string().nullable(),
        passes: z.number().int(),
        airframes: z.number().int(),
      }),
    ),
    by_operator: z.array(
      z.object({
        operator_icao: z.string().nullable(),
        operator_name: z.string().nullable(),
        passes: z.number().int(),
        airframes: z.number().int(),
      }),
    ),
    items: z.array(seenAircraftSchema),
  })
  .openapi('SeenAircraftReport', {
    description:
      'Airframes seen overhead, most-seen first, with pass counts by aircraft type and by ' +
      'operator (top 50 each) over the same filtered passes.',
  });
