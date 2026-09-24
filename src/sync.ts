/**
 * Cross-device sync for the local save, keyed by the Twetch account on the
 * server side. The server stores the game save plus the PIN-encrypted
 * built-in wallet blob and only ever sees ciphertext for keys. Offline-first:
 * failures never block play, they just change the status line.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Save } from "./store";
import {
  adoptKeyBlob, baseRev, chooseAction, keyBlob, localChangedAt, rememberBaseRev, rememberLocalChange,
  type RemoteBlob,
} from "./syncPolicy";

export class SyncAuthError extends Error {}

async function call(path: string, token: string, body: unknown): Promise<{ status: number; json: RemoteBlob & { rev?: number; error?: string } }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as RemoteBlob & { rev?: number; error?: string };
  if (res.status === 401) throw new SyncAuthError("sign in again to sync");
  return { status: res.status, json };
}

export async function pullRemote(token: string): Promise<RemoteBlob> {
  const { json } = await call("/api/sync/pull", token, {});
  return json;
}

export async function pushRemote(
  token: string,
  rev: number,
  updatedAt: number,
  save: Save,
  blob: string,
): Promise<{ rev: number } | { conflict: RemoteBlob }> {
  const { status, json } = await call("/api/sync/push", token, { baseRev: rev, updatedAt, save, keyBlob: blob });
  if (status === 409) return { conflict: json };
  if (status >= 400 || typeof json.rev !== "number") throw new Error(json.error ?? `sync failed (${status})`);
  return { rev: json.rev };
}

export interface SyncStatus {
  state: "off" | "syncing" | "synced" | "error" | "auth";
  note: string;
}

export function useSync(opts: {
  save: Save;
  setSave: Dispatch<SetStateAction<Save>>;
  changedAt: number;
  token: string | null;
  sub: string | null;
}): SyncStatus {
  const { save, setSave, changedAt, token, sub } = opts;
  const [status, setStatus] = useState<SyncStatus>({ state: "off", note: "Sign in with Twetch to sync across devices" });
  const saveRef = useRef(save);
  saveRef.current = save;
  const busy = useRef(false);

  const note = (state: SyncStatus["state"], text: string) => setStatus({ state, note: text });

  const doPush = useCallback(
    async (at: number): Promise<void> => {
      if (!token || busy.current) return;
      busy.current = true;
      try {
        let result = await pushRemote(token, baseRev(), at, saveRef.current, keyBlob());
        if ("conflict" in result) {
          const remote = result.conflict;
          rememberBaseRev(remote.rev);
          if (chooseAction(at, remote) === "adopt-remote" && remote.save) {
            setSave(remote.save);
            adoptKeyBlob(remote.keyBlob);
            note("synced", "pulled a newer save from another device");
            return;
          }
          result = await pushRemote(token, remote.rev, at, saveRef.current, keyBlob());
          if ("conflict" in result) {
            note("error", "sync conflict — will retry");
            return;
          }
        }
        rememberBaseRev(result.rev);
        note("synced", "synced");
      } catch (e) {
        if (e instanceof SyncAuthError) note("auth", "token expired — sign in again to sync");
        else note("error", e instanceof Error ? e.message : "sync failed");
      } finally {
        busy.current = false;
      }
    },
    [token, setSave],
  );

  // First contact for this account: pull, then adopt or push the local save.
  useEffect(() => {
    if (!token || !sub) {
      note("off", "Sign in with Twetch to sync across devices");
      return;
    }
    let cancelled = false;
    (async () => {
      note("syncing", "checking for saves…");
      try {
        const remote = await pullRemote(token);
        if (cancelled) return;
        const local = localChangedAt();
        const action = chooseAction(local, remote);
        if (action === "adopt-remote" && remote.save) {
          setSave(remote.save);
          adoptKeyBlob(remote.keyBlob);
          rememberBaseRev(remote.rev);
          rememberLocalChange(remote.updatedAt);
          note("synced", "loaded your save from another device");
        } else if (action === "push-local") {
          rememberBaseRev(remote.rev ?? 0);
          await doPush(local || Date.now());
        } else {
          rememberBaseRev(remote.rev);
          note("synced", "up to date");
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof SyncAuthError) note("auth", "token expired — sign in again to sync");
        else note("error", e instanceof Error ? e.message : "sync failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, sub]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced push on local changes.
  useEffect(() => {
    if (!token || !changedAt) return;
    const t = setTimeout(() => void doPush(changedAt), 2500);
    return () => clearTimeout(t);
  }, [changedAt, token, doPush]);

  return status;
}
