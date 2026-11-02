import { toast } from "sonner";

export type ActOptions = {
  /** Called with true before the action and false after it, e.g. a `setBusy` state setter. */
  busy?: (on: boolean) => void;
  /** Title of the error toast; without it the error message is the title. */
  failure?: string;
  /** Extra handling of the error, before the toast (e.g. showing per-tool issues). */
  onError?: (error: Error) => void;
};

/**
 * Run a console action with the standard feedback: a busy flag while it runs
 * and an error toast if it fails. Returns the action's result, or undefined if
 * it failed, so the caller only writes the success path:
 *
 *   const next = await act(() => api.saveProfile(...), { busy: setBusy, failure: "Not saved" });
 *   if (next) { onChanged(next); toast.success("Saved"); }
 */
export async function act<T>(run: () => Promise<T>, options: ActOptions = {}): Promise<T | undefined> {
  options.busy?.(true);
  try {
    return await run();
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    options.onError?.(error);
    if (options.failure) toast.error(options.failure, { description: error.message });
    else toast.error(error.message);
    return undefined;
  } finally {
    options.busy?.(false);
  }
}
