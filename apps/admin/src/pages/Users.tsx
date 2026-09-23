import { useCallback, useEffect, useState } from 'react';
import { api, unwrap, type AdminUser } from '../api';
import { fmtAgo, fmtNum } from '../format';

export function Users({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      unwrap(api.GET('/admin/v1/users'))
        .then((d) => setUsers(d.items))
        .catch((e: Error) => setError(e.message)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const setAdmin = async (u: AdminUser, admin: boolean) => {
    const label = u.email ?? u.id;
    if (!confirm(admin ? `Make ${label} an admin?` : `Remove admin access from ${label}?`)) return;
    setBusy(u.id);
    setError('');
    try {
      const params = { params: { path: { id: u.id } } };
      await unwrap(
        admin
          ? api.PUT('/admin/v1/users/{id}/admin', params)
          : api.DELETE('/admin/v1/users/{id}/admin', params),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!users)
    return error ? <p className="notice error">{error}</p> : <p className="muted">Loading…</p>;

  return (
    <section>
      <h1>Users</h1>
      <p className="muted">
        Everyone with an account. Admins can use this board and see every user's frames.
      </p>
      {error && <p className="notice error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th className="num">Frames</th>
              <th className="num">Locations</th>
              <th className="num">Passes recorded</th>
              <th>Last pass</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <div>{u.display_name ?? u.email ?? u.id}</div>
                  {u.display_name && <div className="muted small">{u.email}</div>}
                </td>
                <td>{u.is_admin ? <span className="badge">admin</span> : 'user'}</td>
                <td className="num">{u.device_count}</td>
                <td className="num">{u.location_count}</td>
                <td className="num">{fmtNum(u.overflight_count)}</td>
                <td>{fmtAgo(u.last_overflight_at)}</td>
                <td>{fmtAgo(u.last_sign_in_at)}</td>
                <td className="actions-cell">
                  {u.device_count > 0 && (
                    <a className="button-like small" href={`#/frames?owner=${u.id}`}>
                      Frames →
                    </a>
                  )}
                  {u.is_admin ? (
                    u.id !== currentUserId && (
                      <button
                        className="ghost small"
                        disabled={busy === u.id}
                        onClick={() => setAdmin(u, false)}
                      >
                        Remove admin
                      </button>
                    )
                  ) : (
                    <button
                      className="ghost small"
                      disabled={busy === u.id}
                      onClick={() => setAdmin(u, true)}
                    >
                      Make admin
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
