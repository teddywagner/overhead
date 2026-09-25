import {
  BUCKETS,
  matchArtAsset,
  type ArtCandidate,
  type ArtScope,
  type ArtStatus,
  type BucketName,
} from '@overhead/core';
import type { Sql, TypedSupabaseClient } from '@overhead/database';
import { SIGNED_UPLOAD_TTL_SECONDS } from './lib/storage';

/**
 * Cross-owner images and artwork for the admin board (behind requireAdmin).
 * Images are returned as short-lived signed URLs made with the secret key,
 * since admins are not the objects' owners.
 */

/** How long image links in admin responses stay valid. */
export const ADMIN_IMAGE_URL_TTL_SECONDS = 600;

export interface AdminArtAsset {
  id: string;
  owner_id: string;
  owner_email: string | null;
  aircraft_id: string | null;
  aircraft_registration: string | null;
  icao_type_code: string | null;
  operator_icao: string | null;
  livery_name: string | null;
  registration: string | null;
  scope: ArtScope;
  status: ArtStatus;
  source_image_id: string | null;
  storage_path: string;
  thumbnail_path: string | null;
  generation_provider: string | null;
  generation_model: string | null;
  prompt_version: string | null;
  identity_confidence: number | null;
  reviewer_notes: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  /** The owner's passes in the last 30 days this artwork would be used for. */
  sightings_30d: number;
  image_url: string | null;
  thumbnail_url: string | null;
}

export interface AdminSourceImage {
  id: string;
  owner_id: string;
  owner_email: string | null;
  aircraft_id: string | null;
  aircraft_registration: string | null;
  aircraft_type: string | null;
  source_provider: string;
  source_page_url: string | null;
  original_file_url: string | null;
  storage_path: string | null;
  creator: string | null;
  license_name: string | null;
  license_url: string | null;
  attribution_text: string | null;
  view_angle_score: number | null;
  identity_confidence: number | null;
  created_at: string;
  art_count: number;
  image_url: string | null;
}

export interface AdminPoster {
  id: string;
  owner_id: string;
  owner_email: string | null;
  location_name: string | null;
  local_date: string;
  template_version: string;
  status: string;
  has_binary: boolean;
  binary_verified: boolean;
  generated_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  item_count: number;
  /** Frames pinned to this poster. */
  pinned_on: string[];
  full_color_preview_url: string | null;
  eink_preview_url: string | null;
}

export interface CoverageRow {
  owner_id: string;
  owner_email: string | null;
  operator_icao: string | null;
  operator_name: string | null;
  icao_type_code: string | null;
  manufacturer: string | null;
  model: string | null;
  sightings: number;
  airframes: number;
  last_seen_at: string;
  /** Best approved artwork for this operator + type, or null when there is none. */
  best_scope: ArtScope | null;
  best_art_asset_id: string | null;
  best_thumbnail_url: string | null;
  /** Airframes in this group with their own exact-registration artwork. */
  airframes_with_exact_art: number;
  /** Draft or pending artwork that would cover this group once approved. */
  pending_count: number;
}

/** One airframe seen overhead, across the filtered passes. */
export interface SeenAircraft {
  icao24: string;
  aircraft_id: string | null;
  registration: string | null;
  icao_type_code: string | null;
  manufacturer: string | null;
  model: string | null;
  operator_icao: string | null;
  operator_name: string | null;
  country: string | null;
  passes: number;
  /** Users whose locations it passed over. */
  users: number;
  first_seen_at: string;
  last_seen_at: string;
  closest_distance_m: number;
}

export interface SeenTypeCount {
  icao_type_code: string | null;
  manufacturer: string | null;
  model: string | null;
  passes: number;
  airframes: number;
}

export interface SeenOperatorCount {
  operator_icao: string | null;
  operator_name: string | null;
  passes: number;
  airframes: number;
}

export interface SeenAircraftReport {
  passes: number;
  airframes: number;
  by_type: SeenTypeCount[];
  by_operator: SeenOperatorCount[];
  /** Most-seen first; capped by the request's limit. */
  items: SeenAircraft[];
}

export interface SeenAircraftFilter {
  ownerId?: string;
  days: number;
  includeNearMisses: boolean;
  typeCode?: string;
  operatorIcao?: string;
  /** Restrict to these manufacturers (case-insensitive). */
  manufacturers?: string[];
  limit: number;
}

export interface ArtFilter {
  id?: string;
  ownerId?: string;
  status?: ArtStatus;
  scope?: ArtScope;
  typeCode?: string;
  operatorIcao?: string;
  limit: number;
}

export interface ArtFields {
  scope: ArtScope;
  icao_type_code: string | null;
  operator_icao: string | null;
  livery_name: string | null;
  registration: string | null;
  reviewer_notes: string | null;
}

export interface SignedUpload {
  bucket: string;
  path: string;
  signed_url: string;
  token: string;
  expires_in_seconds: number;
}

export interface AdminAssetsRepository {
  listArt(filter: ArtFilter): Promise<AdminArtAsset[]>;
  artStatusCounts(ownerId?: string): Promise<Record<string, number>>;
  getArt(id: string): Promise<AdminArtAsset | null>;
  createArt(
    ownerId: string,
    fields: ArtFields & { storage_path: string; status: 'draft' | 'pending_review' },
  ): Promise<string>;
  updateArt(id: string, patch: Partial<ArtFields>): Promise<boolean>;
  setArtStatus(
    id: string,
    status: ArtStatus,
    reviewerNotes: string | null | undefined,
    now: Date,
  ): Promise<boolean>;
  artObjectExists(path: string): Promise<boolean>;
  createArtUpload(path: string): Promise<SignedUpload>;
  /** Signed image/thumbnail links for art assets, keyed by asset id. */
  artUrls(
    ids: string[],
  ): Promise<Record<string, { image_url: string | null; thumbnail_url: string | null }>>;
  listSourceImages(filter: { ownerId?: string; limit: number }): Promise<AdminSourceImage[]>;
  listPosters(filter: { ownerId?: string; status?: string; limit: number }): Promise<AdminPoster[]>;
  coverage(filter: {
    ownerId?: string;
    days: number;
    includeNearMisses: boolean;
  }): Promise<CoverageRow[]>;
  /** Airframes seen overhead, with pass counts by type and by operator. */
  seenAircraft(filter: SeenAircraftFilter): Promise<SeenAircraftReport>;
  ownerExists(ownerId: string): Promise<boolean>;
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));
const PENDING: ArtStatus[] = ['draft', 'pending_review'];

/** Whether an art asset applies to an operator + type group (registration scope aside). */
function coversGroup(
  a: { scope: ArtScope; operator_icao: string | null; icao_type_code: string | null },
  g: { operator_icao: string | null; icao_type_code: string | null },
): boolean {
  switch (a.scope) {
    case 'operator_livery':
    case 'operator_type':
      return a.operator_icao === g.operator_icao && a.icao_type_code === g.icao_type_code;
    case 'type':
      return a.icao_type_code === g.icao_type_code;
    case 'fallback':
      return true;
    default:
      return false;
  }
}

export class SqlAdminAssetsRepository implements AdminAssetsRepository {
  constructor(
    private readonly sql: Sql,
    /** Secret-key client: signs URLs for any owner's objects. */
    private readonly storage: TypedSupabaseClient,
  ) {}

  private async sign(
    bucket: BucketName,
    paths: Array<string | null>,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(paths.filter((p): p is string => !!p))];
    if (unique.length === 0) return new Map();
    const { data, error } = await this.storage.storage
      .from(bucket)
      .createSignedUrls(unique, ADMIN_IMAGE_URL_TTL_SECONDS);
    if (error || !data) return new Map();
    return new Map(
      data
        .filter((d) => d.path && d.signedUrl && !d.error)
        .map((d) => [d.path as string, d.signedUrl as string] as const),
    );
  }

  async listArt(f: ArtFilter): Promise<AdminArtAsset[]> {
    const rows = (await this.sql`
      select a.id, a.owner_id, u.email as owner_email, a.aircraft_id,
             ac.registration as aircraft_registration, a.icao_type_code, a.operator_icao,
             a.livery_name, a.registration, a.scope, a.status, a.source_image_id, a.storage_path,
             a.thumbnail_path, a.generation_provider, a.generation_model, a.prompt_version,
             a.identity_confidence, a.reviewer_notes, a.approved_at, a.created_at, a.updated_at,
             (select count(*)::int
                from public.overflights o
                left join public.aircraft oa on oa.id = o.aircraft_id
               where o.owner_id = a.owner_id
                 and o.closest_seen_at > now() - interval '30 days'
                 and case a.scope
                       when 'registration' then coalesce(o.registration, oa.registration) = a.registration
                       when 'type' then oa.icao_type_code = a.icao_type_code
                       when 'fallback' then true
                       else oa.operator_icao = a.operator_icao and oa.icao_type_code = a.icao_type_code
                     end) as sightings_30d
        from public.art_assets a
        left join auth.users u on u.id = a.owner_id
        left join public.aircraft ac on ac.id = a.aircraft_id
       where (${f.id ?? null}::uuid is null or a.id = ${f.id ?? null}::uuid)
         and (${f.ownerId ?? null}::uuid is null or a.owner_id = ${f.ownerId ?? null}::uuid)
         and (${f.status ?? null}::text is null or a.status = ${f.status ?? null})
         and (${f.scope ?? null}::text is null or a.scope = ${f.scope ?? null})
         and (${f.typeCode ?? null}::text is null or a.icao_type_code = ${f.typeCode ?? null})
         and (${f.operatorIcao ?? null}::text is null or a.operator_icao = ${f.operatorIcao ?? null})
       order by case a.status when 'pending_review' then 0 when 'draft' then 1 else 2 end,
                a.created_at desc, a.id desc
       limit ${f.limit}`) as Row[];
    const urls = await this.sign(
      BUCKETS.aircraftArt,
      rows.flatMap((r) => [strOrNull(r.storage_path), strOrNull(r.thumbnail_path)]),
    );
    return rows.map((r) => {
      const storagePath = String(r.storage_path);
      const thumbPath = strOrNull(r.thumbnail_path);
      return {
        id: String(r.id),
        owner_id: String(r.owner_id),
        owner_email: strOrNull(r.owner_email),
        aircraft_id: strOrNull(r.aircraft_id),
        aircraft_registration: strOrNull(r.aircraft_registration),
        icao_type_code: strOrNull(r.icao_type_code),
        operator_icao: strOrNull(r.operator_icao),
        livery_name: strOrNull(r.livery_name),
        registration: strOrNull(r.registration),
        scope: r.scope as ArtScope,
        status: r.status as ArtStatus,
        source_image_id: strOrNull(r.source_image_id),
        storage_path: storagePath,
        thumbnail_path: thumbPath,
        generation_provider: strOrNull(r.generation_provider),
        generation_model: strOrNull(r.generation_model),
        prompt_version: strOrNull(r.prompt_version),
        identity_confidence: numOrNull(r.identity_confidence),
        reviewer_notes: strOrNull(r.reviewer_notes),
        approved_at: iso(r.approved_at),
        created_at: iso(r.created_at)!,
        updated_at: iso(r.updated_at)!,
        sightings_30d: Number(r.sightings_30d),
        image_url: urls.get(storagePath) ?? null,
        thumbnail_url: (thumbPath && urls.get(thumbPath)) || urls.get(storagePath) || null,
      };
    });
  }

  async artStatusCounts(ownerId?: string): Promise<Record<string, number>> {
    const rows = (await this.sql`
      select status, count(*)::int as n from public.art_assets
       where (${ownerId ?? null}::uuid is null or owner_id = ${ownerId ?? null}::uuid)
       group by status`) as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  }

  async getArt(id: string): Promise<AdminArtAsset | null> {
    const [art] = await this.listArt({ id, limit: 1 });
    return art ?? null;
  }

  async createArt(
    ownerId: string,
    f: ArtFields & { storage_path: string; status: 'draft' | 'pending_review' },
  ): Promise<string> {
    const rows = (await this.sql`
      insert into public.art_assets
        (owner_id, scope, icao_type_code, operator_icao, livery_name, registration,
         reviewer_notes, storage_path, status)
      values (${ownerId}, ${f.scope}, ${f.icao_type_code}, ${f.operator_icao}, ${f.livery_name},
              ${f.registration}, ${f.reviewer_notes}, ${f.storage_path}, ${f.status})
      returning id`) as Row[];
    return String(rows[0]!.id);
  }

  async updateArt(id: string, p: Partial<ArtFields>): Promise<boolean> {
    // Absent keys keep their value; explicit nulls clear the column.
    const has = (k: keyof ArtFields) => Object.hasOwn(p, k);
    const rows = (await this.sql`
      update public.art_assets set
        scope = case when ${has('scope')} then ${p.scope ?? null} else scope end,
        icao_type_code = case when ${has('icao_type_code')} then ${p.icao_type_code ?? null} else icao_type_code end,
        operator_icao = case when ${has('operator_icao')} then ${p.operator_icao ?? null} else operator_icao end,
        livery_name = case when ${has('livery_name')} then ${p.livery_name ?? null} else livery_name end,
        registration = case when ${has('registration')} then ${p.registration ?? null} else registration end,
        reviewer_notes = case when ${has('reviewer_notes')} then ${p.reviewer_notes ?? null} else reviewer_notes end
       where id = ${id}
      returning id`) as Row[];
    return rows.length === 1;
  }

  async setArtStatus(
    id: string,
    status: ArtStatus,
    notes: string | null | undefined,
    now: Date,
  ): Promise<boolean> {
    const approvedAt = status === 'approved' ? now.toISOString() : null;
    const rows = (await this.sql`
      update public.art_assets set
        status = ${status},
        approved_at = ${approvedAt}::timestamptz,
        reviewer_notes = case when ${notes !== undefined} then ${notes ?? null} else reviewer_notes end
       where id = ${id}
      returning id`) as Row[];
    return rows.length === 1;
  }

  async artObjectExists(path: string): Promise<boolean> {
    const { data, error } = await this.storage.storage.from(BUCKETS.aircraftArt).exists(path);
    return !error && data === true;
  }

  async createArtUpload(path: string): Promise<SignedUpload> {
    const { data, error } = await this.storage.storage
      .from(BUCKETS.aircraftArt)
      .createSignedUploadUrl(path);
    if (error || !data) throw new Error('could not create upload URL');
    return {
      bucket: BUCKETS.aircraftArt,
      path: data.path,
      signed_url: data.signedUrl,
      token: data.token,
      expires_in_seconds: SIGNED_UPLOAD_TTL_SECONDS,
    };
  }

  async artUrls(ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return {};
    const rows = (await this.sql`
      select id, storage_path, thumbnail_path from public.art_assets
       where id in ${this.sql(unique)}`) as Row[];
    const urls = await this.sign(
      BUCKETS.aircraftArt,
      rows.flatMap((r) => [strOrNull(r.storage_path), strOrNull(r.thumbnail_path)]),
    );
    return Object.fromEntries(
      rows.map((r) => {
        const image = urls.get(String(r.storage_path)) ?? null;
        const thumb = strOrNull(r.thumbnail_path);
        return [
          String(r.id),
          { image_url: image, thumbnail_url: (thumb && urls.get(thumb)) || image },
        ];
      }),
    );
  }

  async listSourceImages(f: { ownerId?: string; limit: number }): Promise<AdminSourceImage[]> {
    const rows = (await this.sql`
      select s.id, s.owner_id, u.email as owner_email, s.aircraft_id,
             ac.registration as aircraft_registration, ac.icao_type_code as aircraft_type,
             s.source_provider, s.source_page_url, s.original_file_url, s.storage_path, s.creator,
             s.license_name, s.license_url, s.attribution_text, s.view_angle_score,
             s.identity_confidence, s.created_at,
             (select count(*)::int from public.art_assets a where a.source_image_id = s.id) as art_count
        from public.source_images s
        left join auth.users u on u.id = s.owner_id
        left join public.aircraft ac on ac.id = s.aircraft_id
       where (${f.ownerId ?? null}::uuid is null or s.owner_id = ${f.ownerId ?? null}::uuid)
       order by s.created_at desc, s.id desc
       limit ${f.limit}`) as Row[];
    const urls = await this.sign(
      BUCKETS.sourceImages,
      rows.map((r) => strOrNull(r.storage_path)),
    );
    return rows.map((r) => ({
      id: String(r.id),
      owner_id: String(r.owner_id),
      owner_email: strOrNull(r.owner_email),
      aircraft_id: strOrNull(r.aircraft_id),
      aircraft_registration: strOrNull(r.aircraft_registration),
      aircraft_type: strOrNull(r.aircraft_type),
      source_provider: String(r.source_provider),
      source_page_url: strOrNull(r.source_page_url),
      original_file_url: strOrNull(r.original_file_url),
      storage_path: strOrNull(r.storage_path),
      creator: strOrNull(r.creator),
      license_name: strOrNull(r.license_name),
      license_url: strOrNull(r.license_url),
      attribution_text: strOrNull(r.attribution_text),
      view_angle_score: numOrNull(r.view_angle_score),
      identity_confidence: numOrNull(r.identity_confidence),
      created_at: iso(r.created_at)!,
      art_count: Number(r.art_count),
      image_url: r.storage_path ? (urls.get(String(r.storage_path)) ?? null) : null,
    }));
  }

  async listPosters(f: {
    ownerId?: string;
    status?: string;
    limit: number;
  }): Promise<AdminPoster[]> {
    const rows = (await this.sql`
      select p.id, p.owner_id, u.email as owner_email, l.name as location_name, p.local_date,
             p.template_version, p.status, p.device_binary_path is not null as has_binary,
             p.binary_sha256 is not null as binary_verified, p.generated_at, p.error,
             p.created_at, p.updated_at, p.full_color_preview_path, p.eink_preview_path,
             (select count(*)::int from public.poster_items i where i.poster_id = p.id) as item_count,
             (select coalesce(jsonb_agg(d.name order by d.name), '[]'::jsonb)
                from public.devices d where d.latest_poster_id = p.id) as pinned_on
        from public.posters p
        left join auth.users u on u.id = p.owner_id
        left join public.locations l on l.id = p.location_id
       where (${f.ownerId ?? null}::uuid is null or p.owner_id = ${f.ownerId ?? null}::uuid)
         and (${f.status ?? null}::text is null or p.status = ${f.status ?? null})
       order by p.local_date desc, p.created_at desc
       limit ${f.limit}`) as Row[];
    const urls = await this.sign(
      BUCKETS.posterPreviews,
      rows.flatMap((r) => [strOrNull(r.full_color_preview_path), strOrNull(r.eink_preview_path)]),
    );
    const url = (p: unknown) => (p ? (urls.get(String(p)) ?? null) : null);
    return rows.map((r) => ({
      id: String(r.id),
      owner_id: String(r.owner_id),
      owner_email: strOrNull(r.owner_email),
      location_name: strOrNull(r.location_name),
      local_date:
        r.local_date instanceof Date
          ? r.local_date.toISOString().slice(0, 10)
          : String(r.local_date).slice(0, 10),
      template_version: String(r.template_version),
      status: String(r.status),
      has_binary: Boolean(r.has_binary),
      binary_verified: Boolean(r.binary_verified),
      generated_at: iso(r.generated_at),
      error: strOrNull(r.error),
      created_at: iso(r.created_at)!,
      updated_at: iso(r.updated_at)!,
      item_count: Number(r.item_count),
      pinned_on: (r.pinned_on as string[]) ?? [],
      full_color_preview_url: url(r.full_color_preview_path),
      eink_preview_url: url(r.eink_preview_path),
    }));
  }

  async coverage(f: {
    ownerId?: string;
    days: number;
    includeNearMisses: boolean;
  }): Promise<CoverageRow[]> {
    const groups = (await this.sql`
      select o.owner_id, u.email as owner_email, a.operator_icao, a.icao_type_code,
             max(a.operator_name) as operator_name, max(a.manufacturer) as manufacturer,
             max(a.model) as model, count(*)::int as sightings,
             count(distinct o.icao24)::int as airframes, max(o.closest_seen_at) as last_seen_at,
             coalesce(to_jsonb(array_agg(distinct coalesce(o.registration, a.registration))
                        filter (where coalesce(o.registration, a.registration) is not null)),
                      '[]'::jsonb) as registrations
        from public.overflights o
        left join public.aircraft a on a.id = o.aircraft_id
        left join auth.users u on u.id = o.owner_id
       where o.closest_seen_at > now() - make_interval(days => ${f.days})
         and (o.status = 'qualified' or ${f.includeNearMisses})
         and (${f.ownerId ?? null}::uuid is null or o.owner_id = ${f.ownerId ?? null}::uuid)
       group by o.owner_id, u.email, a.operator_icao, a.icao_type_code
       order by sightings desc, last_seen_at desc
       limit 300`) as Row[];
    if (groups.length === 0) return [];

    const owners = [...new Set(groups.map((g) => String(g.owner_id)))];
    const art = (await this.sql`
      select id, owner_id, scope, status, registration, operator_icao, icao_type_code,
             livery_name, approved_at, storage_path, thumbnail_path
        from public.art_assets
       where owner_id in ${this.sql(owners)} and status in ('approved', 'draft', 'pending_review')`) as Row[];
    const assets = art.map((a) => ({
      id: String(a.id),
      owner_id: String(a.owner_id),
      scope: a.scope as ArtScope,
      status: a.status as ArtStatus,
      registration: strOrNull(a.registration),
      operator_icao: strOrNull(a.operator_icao),
      icao_type_code: strOrNull(a.icao_type_code),
      livery_name: strOrNull(a.livery_name),
      approved_at: iso(a.approved_at),
      path: strOrNull(a.thumbnail_path) ?? String(a.storage_path),
    }));

    const rows = groups.map((g) => {
      const ownerId = String(g.owner_id);
      const group = {
        operator_icao: strOrNull(g.operator_icao),
        icao_type_code: strOrNull(g.icao_type_code),
      };
      const mine = assets.filter((a) => a.owner_id === ownerId);
      const best = matchArtAsset<ArtCandidate & { path: string }>(
        { ...group, registration: null },
        mine,
      );
      const regs = new Set(g.registrations as string[]);
      const exact = new Set(
        mine
          .filter((a) => a.status === 'approved' && a.scope === 'registration' && a.registration)
          .map((a) => a.registration!)
          .filter((r) => regs.has(r)),
      );
      const pending = mine.filter(
        (a) =>
          PENDING.includes(a.status) &&
          (coversGroup(a, group) || (a.scope === 'registration' && regs.has(a.registration ?? ''))),
      );
      return { g, ownerId, group, best, exact: exact.size, pending: pending.length };
    });

    const urls = await this.sign(
      BUCKETS.aircraftArt,
      rows.map((r) => r.best?.path ?? null),
    );
    return rows.map(({ g, ownerId, group, best, exact, pending }) => ({
      owner_id: ownerId,
      owner_email: strOrNull(g.owner_email),
      ...group,
      operator_name: strOrNull(g.operator_name),
      manufacturer: strOrNull(g.manufacturer),
      model: strOrNull(g.model),
      sightings: Number(g.sightings),
      airframes: Number(g.airframes),
      last_seen_at: iso(g.last_seen_at)!,
      best_scope: best?.scope ?? null,
      best_art_asset_id: best?.id ?? null,
      best_thumbnail_url: best ? (urls.get(best.path) ?? null) : null,
      airframes_with_exact_art: exact,
      pending_count: pending,
    }));
  }

  async seenAircraft(f: SeenAircraftFilter): Promise<SeenAircraftReport> {
    // Manufacturer prefixes ("airbus" also matches "Airbus Canada"), comma-joined.
    const makers = f.manufacturers?.length
      ? f.manufacturers.map((m) => m.trim().toLowerCase()).join(',')
      : null;
    const [r] = (await this.sql`
      with seen as (
        select o.owner_id, o.icao24, o.first_seen_at, o.closest_seen_at, o.minimum_distance_m,
               a.id as aircraft_id, coalesce(a.registration, o.registration) as registration,
               a.icao_type_code, a.manufacturer, a.model, a.operator_icao, a.operator_name,
               a.country
          from public.overflights o
          left join public.aircraft a on a.id = o.aircraft_id
         where o.closest_seen_at > now() - make_interval(days => ${f.days})
           and (o.status = 'qualified' or ${f.includeNearMisses})
           and (${f.ownerId ?? null}::uuid is null or o.owner_id = ${f.ownerId ?? null}::uuid)
           and (${f.typeCode ?? null}::text is null or a.icao_type_code = ${f.typeCode ?? null})
           and (${f.operatorIcao ?? null}::text is null or a.operator_icao = ${f.operatorIcao ?? null})
           and (${makers}::text is null or exists (
                 select 1 from unnest(string_to_array(${makers}::text, ',')) m
                  where lower(a.manufacturer) like m || '%'))
      )
      select
        (select count(*)::int from seen) as passes,
        (select count(distinct icao24)::int from seen) as airframes,
        (select coalesce(jsonb_agg(t order by t.passes desc, t.icao_type_code), '[]'::jsonb)
           from (select icao_type_code, max(manufacturer) as manufacturer, max(model) as model,
                        count(*)::int as passes, count(distinct icao24)::int as airframes
                   from seen group by icao_type_code
                  order by passes desc limit 50) t) as by_type,
        (select coalesce(jsonb_agg(t order by t.passes desc, t.operator_icao), '[]'::jsonb)
           from (select operator_icao, max(operator_name) as operator_name,
                        count(*)::int as passes, count(distinct icao24)::int as airframes
                   from seen group by operator_icao
                  order by passes desc limit 50) t) as by_operator,
        (select coalesce(jsonb_agg(t order by t.passes desc, t.last_seen_at desc), '[]'::jsonb)
           from (select icao24, max(aircraft_id::text) as aircraft_id,
                        max(registration) as registration, max(icao_type_code) as icao_type_code,
                        max(manufacturer) as manufacturer, max(model) as model,
                        max(operator_icao) as operator_icao, max(operator_name) as operator_name,
                        max(country) as country, count(*)::int as passes,
                        count(distinct owner_id)::int as users,
                        min(first_seen_at) as first_seen_at, max(closest_seen_at) as last_seen_at,
                        min(minimum_distance_m) as closest_distance_m
                   from seen group by icao24
                  order by passes desc, last_seen_at desc limit ${f.limit}) t) as items`) as Row[];

    const items = (r!.items as Row[]).map((i) => ({
      icao24: String(i.icao24),
      aircraft_id: strOrNull(i.aircraft_id),
      registration: strOrNull(i.registration),
      icao_type_code: strOrNull(i.icao_type_code),
      manufacturer: strOrNull(i.manufacturer),
      model: strOrNull(i.model),
      operator_icao: strOrNull(i.operator_icao),
      operator_name: strOrNull(i.operator_name),
      country: strOrNull(i.country),
      passes: Number(i.passes),
      users: Number(i.users),
      first_seen_at: iso(i.first_seen_at)!,
      last_seen_at: iso(i.last_seen_at)!,
      closest_distance_m: Number(i.closest_distance_m),
    }));
    return {
      passes: Number(r!.passes),
      airframes: Number(r!.airframes),
      by_type: (r!.by_type as Row[]).map((t) => ({
        icao_type_code: strOrNull(t.icao_type_code),
        manufacturer: strOrNull(t.manufacturer),
        model: strOrNull(t.model),
        passes: Number(t.passes),
        airframes: Number(t.airframes),
      })),
      by_operator: (r!.by_operator as Row[]).map((o) => ({
        operator_icao: strOrNull(o.operator_icao),
        operator_name: strOrNull(o.operator_name),
        passes: Number(o.passes),
        airframes: Number(o.airframes),
      })),
      items,
    };
  }

  async ownerExists(ownerId: string): Promise<boolean> {
    const rows = (await this.sql`select 1 from auth.users where id = ${ownerId}`) as Row[];
    return rows.length === 1;
  }
}
