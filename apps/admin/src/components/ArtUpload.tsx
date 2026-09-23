import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, unwrap, type AdminUser, type Schemas } from '../api';
import { SCOPE_LABEL } from '../format';
import { supabase } from '../supabase';

type Scope = Schemas['AdminArtCreate']['scope'];
export interface ArtPrefill {
  owner_id?: string;
  scope?: Scope;
  icao_type_code?: string | null;
  operator_icao?: string | null;
  registration?: string | null;
}

const CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
type ContentType = (typeof CONTENT_TYPES)[number];

/** Scope → which tag fields it needs. */
const NEEDS: Record<
  Scope,
  Array<'registration' | 'operator_icao' | 'icao_type_code' | 'livery_name'>
> = {
  registration: ['registration'],
  operator_livery: ['operator_icao', 'icao_type_code', 'livery_name'],
  operator_type: ['operator_icao', 'icao_type_code'],
  type: ['icao_type_code'],
  fallback: [],
};

/** Upload artwork into a user's folder and create its art asset record. */
export function ArtUpload({
  users,
  prefill,
  onClose,
  onCreated,
}: {
  users: AdminUser[];
  prefill?: ArtPrefill;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [ownerId, setOwnerId] = useState(prefill?.owner_id ?? users[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>(prefill?.scope ?? 'operator_type');
  const [fields, setFields] = useState({
    registration: prefill?.registration ?? '',
    operator_icao: prefill?.operator_icao ?? '',
    icao_type_code: prefill?.icao_type_code ?? '',
    livery_name: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [approve, setApprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError('Choose an image file.');
    if (!CONTENT_TYPES.includes(file.type as ContentType)) {
      return setError('Use a PNG, JPEG or WebP image.');
    }
    setBusy(true);
    setError('');
    try {
      const upload = await unwrap(
        api.POST('/admin/v1/art-assets/upload-url', {
          body: { owner_id: ownerId, filename: file.name, content_type: file.type as ContentType },
        }),
      );
      const stored = await supabase.storage
        .from(upload.bucket)
        .uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type });
      if (stored.error) throw new Error(`Upload failed: ${stored.error.message}`);

      const tag = (k: keyof typeof fields) =>
        NEEDS[scope].includes(k) && fields[k].trim() ? fields[k].trim().toUpperCase() : null;
      await unwrap(
        api.POST('/admin/v1/art-assets', {
          body: {
            owner_id: ownerId,
            storage_path: upload.path,
            scope,
            registration: tag('registration'),
            operator_icao: tag('operator_icao'),
            icao_type_code: tag('icao_type_code'),
            livery_name: NEEDS[scope].includes('livery_name')
              ? fields.livery_name.trim() || null
              : null,
            approve,
          },
        }),
      );
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="panel-head">
          <h2>Add artwork</h2>
          <button type="button" className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="stack">
          For user
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email ?? u.id}
              </option>
            ))}
          </select>
        </label>
        <label className="stack">
          Used for
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            {(Object.keys(NEEDS) as Scope[]).map((s) => (
              <option key={s} value={s}>
                {SCOPE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        {NEEDS[scope].includes('registration') && (
          <label className="stack">
            Registration
            <input
              value={fields.registration}
              placeholder="N101OH"
              onChange={(e) => setFields({ ...fields, registration: e.target.value })}
              required
            />
          </label>
        )}
        {NEEDS[scope].includes('operator_icao') && (
          <label className="stack">
            Operator (ICAO)
            <input
              value={fields.operator_icao}
              placeholder="AAL"
              onChange={(e) => setFields({ ...fields, operator_icao: e.target.value })}
              required
            />
          </label>
        )}
        {NEEDS[scope].includes('icao_type_code') && (
          <label className="stack">
            Aircraft type (ICAO)
            <input
              value={fields.icao_type_code}
              placeholder="B738"
              onChange={(e) => setFields({ ...fields, icao_type_code: e.target.value })}
              required
            />
          </label>
        )}
        {NEEDS[scope].includes('livery_name') && (
          <label className="stack">
            Livery
            <input
              value={fields.livery_name}
              placeholder="Retro 1970s"
              onChange={(e) => setFields({ ...fields, livery_name: e.target.value })}
              required
            />
          </label>
        )}
        <label className="stack">
          Image (PNG, JPEG or WebP, up to 20 MB)
          <input
            type="file"
            accept={CONTENT_TYPES.join(',')}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {previewUrl && <img className="upload-preview" src={previewUrl} alt="" />}
        <label className="check">
          <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
          Approve now (otherwise it waits in review)
        </label>
        {error && <p className="notice error">{error}</p>}
        <div className="actions">
          <button type="submit" disabled={busy || !ownerId}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </div>
  );
}
