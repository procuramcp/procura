import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Me, TeamRole } from "./api";

export type Loaded<T> = { data?: T; error?: Error; loading: boolean; reload: () => void; set: (data: T) => void };

/** Load once per dependency change; `reload` runs it again, `set` replaces the data after a save. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    run().then(
      (data) => live && setState({ data, loading: false }),
      (error: Error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [run, tick]);
  return { ...state, reload: () => setTick((n) => n + 1), set: (data: T) => setState({ data, loading: false }) };
}

export const MeContext = createContext<Me | undefined>(undefined);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside a signed-in page");
  return me;
}

const RANK: Record<TeamRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/**
 * What the signed-in user may do in a tenant (D-038), for hiding controls they
 * can't use. The server checks every request anyway.
 */
export function useRole(tenantId: string): { role: TeamRole | undefined; canEdit: boolean; isAdmin: boolean; isOwner: boolean } {
  const role = useMe().tenants.find((t) => t.id === tenantId)?.role;
  const rank = role ? RANK[role] : 0;
  return { role, canEdit: rank >= RANK.editor, isAdmin: rank >= RANK.admin, isOwner: rank >= RANK.owner };
}
