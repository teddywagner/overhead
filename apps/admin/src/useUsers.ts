import { useEffect, useState } from 'react';
import { api, unwrap, type AdminUser } from './api';

/** All users, for owner pickers and filters. */
export function useUsers(): AdminUser[] {
  const [users, setUsers] = useState<AdminUser[]>([]);
  useEffect(() => {
    unwrap(api.GET('/admin/v1/users'))
      .then((d) => setUsers(d.items))
      .catch(() => setUsers([]));
  }, []);
  return users;
}
