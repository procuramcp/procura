import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Me } from "./api";

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
