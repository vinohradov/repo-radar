import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Scan } from "@repo-radar/shared";
import { useScans } from "./api/hooks.js";
import { AppShell } from "./components/AppShell.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Issues } from "./pages/Issues.js";
import { Reports } from "./pages/Reports.js";
import { Agents } from "./pages/Agents.js";
import { Settings } from "./pages/Settings.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

/**
 * The single source of truth for "which scan am I working on".
 * Every scan-scoped page (Dashboard / Issues / Reports) and the persistent
 * ScanContextBar read the resolved scan from here instead of re-deriving
 * their own fallback.
 */
interface ScanContextValue {
  scans: Scan[];
  /** Resolved scan: the user's explicit pick if it still exists, else the most recent. */
  currentScan: Scan | null;
  currentScanId: string | null;
  /** True when the user explicitly picked the scan (vs defaulting to latest). */
  isExplicit: boolean;
  setSelectedScanId: (id: string | null) => void;
}
const ScanCtx = createContext<ScanContextValue>({
  scans: [],
  currentScan: null,
  currentScanId: null,
  isExplicit: false,
  setSelectedScanId: () => {},
});
export const useScanContext = () => useContext(ScanCtx);

function ScanContextProvider({ children }: { children: ReactNode }) {
  const scansQuery = useScans();
  const [selectedScanId, setSelected] = useState<string | null>(
    () => localStorage.getItem("rr:selectedScan"),
  );
  useEffect(() => {
    if (selectedScanId) localStorage.setItem("rr:selectedScan", selectedScanId);
    else localStorage.removeItem("rr:selectedScan");
  }, [selectedScanId]);

  const scans = scansQuery.data ?? [];
  const explicit = selectedScanId ? scans.find((s) => s.id === selectedScanId) ?? null : null;
  const currentScan = explicit ?? scans[0] ?? null;

  // A deleted scan can leave a stale id behind — clear it once the list is in.
  useEffect(() => {
    if (scansQuery.data && selectedScanId && !scansQuery.data.some((s) => s.id === selectedScanId)) {
      setSelected(null);
    }
  }, [scansQuery.data, selectedScanId]);

  return (
    <ScanCtx.Provider
      value={{
        scans,
        currentScan,
        currentScanId: currentScan?.id ?? null,
        isExplicit: explicit !== null,
        setSelectedScanId: setSelected,
      }}
    >
      {children}
    </ScanCtx.Provider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ScanContextProvider>
        <BrowserRouter>
          <AppShell>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/issues" element={<Issues />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </AppShell>
        </BrowserRouter>
      </ScanContextProvider>
    </QueryClientProvider>
  );
}
