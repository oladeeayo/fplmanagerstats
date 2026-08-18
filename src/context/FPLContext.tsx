import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';

interface FPLState {
  activeTab: string;
  bootstrap: any;
  fixtures: any[];
  currentGameweek: number;
  // Add more fields as needed
}

interface FPLContextValue {
  state: FPLState;
  setState: (updater: Partial<FPLState> | ((prev: FPLState) => Partial<FPLState>)) => void;
  apiFetch: (url: string) => Promise<any>;
  getCachedTabData: (key: string) => any | null;
  setCachedTabData: (key: string, data: any) => void;
}

type StateUpdater = Partial<FPLState> | ((prev: FPLState) => Partial<FPLState>);

const FPLContext = createContext<FPLContextValue | null>(null);

const DEFAULT_STATE: FPLState = {
  activeTab: 'general',
  bootstrap: null,
  fixtures: [],
  currentGameweek: 0,
};

export function FPLProvider({ children }: { children: ReactNode }) {
  const [state, setRawState] = useState<FPLState>(DEFAULT_STATE);
  const cacheRef = useRef(new Map<string, any>());

  const setState = useCallback((updater: StateUpdater) => {
    setRawState(prev => {
      const partial = typeof updater === 'function' ? updater(prev) : updater;
      return { ...prev, ...partial };
    });
  }, []);

  const apiFetch = useCallback(async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }, []);

  const getCachedTabData = useCallback((key: string) => {
    return cacheRef.current.get(key) ?? null;
  }, []);

  const setCachedTabData = useCallback((key: string, data: any) => {
    cacheRef.current.set(key, data);
  }, []);

  // Sync with window.FPL when available
  useEffect(() => {
    const fpl = window.FPL;
    if (!fpl) return;

    // Pull bootstrap data from FPL state if available
    if (fpl.state?.bootstrap) {
      setState({ bootstrap: fpl.state.bootstrap, currentGameweek: fpl.state.currentGameweek || 0 });
    }
  }, [setState]);

  return (
    <FPLContext.Provider value={{ state, setState, apiFetch, getCachedTabData, setCachedTabData }}>
      {children}
    </FPLContext.Provider>
  );
}

export function useFPL() {
  const ctx = useContext(FPLContext);
  if (!ctx) throw new Error('useFPL must be used within FPLProvider');
  return ctx;
}
