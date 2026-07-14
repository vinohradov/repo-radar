import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/issues", label: "Issues" },
  { to: "/reports", label: "Reports" },
  { to: "/agents", label: "Agents" },
  { to: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
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
      <main className="content">{children}</main>
    </div>
  );
}
