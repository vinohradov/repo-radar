import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./components/AppShell.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Issues } from "./pages/Issues.js";
import { Reports } from "./pages/Reports.js";
import { Agents } from "./pages/Agents.js";
import { Settings } from "./pages/Settings.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

/* A tiny selection context so Issues/Reports know which scan to show. */
interface Selection {
  selectedScanId: string | null;
  setSelectedScanId: (id: string | null) => void;
}
const SelectionCtx = createContext<Selection>({ selectedScanId: null, setSelectedScanId: () => {} });
export const useSelection = () => useContext(SelectionCtx);

function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedScanId, setSelected] = useState<string | null>(
    () => localStorage.getItem("rr:selectedScan"),
  );
  useEffect(() => {
    if (selectedScanId) localStorage.setItem("rr:selectedScan", selectedScanId);
  }, [selectedScanId]);
  return (
    <SelectionCtx.Provider value={{ selectedScanId, setSelectedScanId: setSelected }}>
      {children}
    </SelectionCtx.Provider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SelectionProvider>
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
      </SelectionProvider>
    </QueryClientProvider>
  );
}
