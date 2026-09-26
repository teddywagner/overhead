/**
 * Cutouts: copies of reference photos with the background removed, so the
 * aircraft stands alone. Shared by the API (which queues requests) and the
 * worker (which makes them).
 */

export const CUTOUT_STATUSES = ['pending', 'processing', 'done', 'failed'] as const;
export type CutoutStatus = (typeof CUTOUT_STATUSES)[number];

/** Attempts before a failing cutout is left alone until it is requested again. */
export const CUTOUT_MAX_ATTEMPTS = 3;

/** Where a source image's cutout lives in the source-images bucket. */
export function cutoutPath(ownerId: string, sourceImageId: string): string {
  return `${ownerId}/cutout/${sourceImageId}.png`;
}

export interface CutoutSubject {
  source_provider: string;
  license_name: string | null;
  /** Set for photos uploaded by the owner (as opposed to linked picks). */
  storage_path: string | null;
}

/**
 * Why a photo may not be cut out, or null when it may. A cutout is an
 * edited copy, so the photo's licence must allow derivatives: the owner's own
 * uploads do, as do Wikimedia Commons files (free licences only; NoDerivs is
 * not accepted there, but a recorded ND licence is still refused).
 * Planespotters.net and airport-data.com photos may only be linked to.
 */
export function cutoutRefusal(photo: CutoutSubject): string | null {
  if (photo.storage_path) return null;
  switch (photo.source_provider) {
    case 'wikimedia_commons':
      if (!photo.license_name) return 'No licence is recorded for this photo.';
      if (/(^|[^a-z])nd([^a-z]|$)|no ?deriv/i.test(photo.license_name)) {
        return `Its licence (${photo.license_name}) does not allow edited copies.`;
      }
      return null;
    case 'planespotters':
      return 'Planespotters.net photos may only be linked to, not copied or edited.';
    case 'adsbdb':
      return 'airport-data.com photos come with no licence for edited copies.';
    default:
      return 'This photo’s licence does not allow edited copies.';
  }
}
