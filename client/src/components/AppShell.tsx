import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ScanContextBar } from "./ScanContextBar.js";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/issues", label: "Issues" },
  { to: "/reports", label: "Reports" },
  { to: "/agents", label: "Agents" },
  { to: "/settings", label: "Settings" },
];

/* Pages whose content is scoped to one scan and therefore show the context bar. */
const SCAN_SCOPED = new Set(["/", "/issues", "/reports"]);

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div className="app-shell">
      <nav className="sidenav">
        <div className="brand">
          <span className="brand-dot" />
          Repo Radar
        </div>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            {n.label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        {SCAN_SCOPED.has(pathname) && <ScanContextBar />}
        {children}
      </main>
    </div>
  );
}
