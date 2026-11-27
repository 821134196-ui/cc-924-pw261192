import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyWorkspace, normalizeWorkspace } from '../domain/execution';
import { SCENARIO_VERSION } from '../domain/scenario';
import type { Workspace } from '../domain/types';

const KEY = 'drillbench.workspace.v1';

function load(): Workspace {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyWorkspace(SCENARIO_VERSION);
    return normalizeWorkspace(JSON.parse(raw), SCENARIO_VERSION);
  } catch {
    return emptyWorkspace(SCENARIO_VERSION);
  }
}

/**
 * Drill state is persisted locally so a page reload cannot re-run an already
 * executed step: the effect ledger is the source of truth for "already done".
 */
export function useWorkspace() {
  const [state, setState] = useState<Workspace>(() => load());
  const [storageError, setStorageError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(state));
        setStorageError(null);
      } catch {
        setStorageError('本地存储不可用，本次演练记录只保留在当前页面内。');
      }
    }, 120);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [state]);

  const reset = useCallback(() => {
    setState(emptyWorkspace(SCENARIO_VERSION));
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return { workspace: state, setWorkspace: setState, reset, storageError };
}
