"use client";

import { useState } from "react";

const NAV_LINKS = [
  { href: "/",          label: "Overview" },
  { href: "/students",  label: "Students" },
  { href: "/financial", label: "Financial" },
  { href: "/teachers",  label: "Teachers" },
  { href: "/comercial", label: "Comercial" },
  { href: "/todos",     label: "To-Do" },
  { href: "/quality",   label: "Quality" },
];

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Frozen header */}
      <header className="h-14 border-b flex items-center justify-between px-6 shrink-0 bg-white z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCollapsed(c => !c)}
            className="p-1.5 rounded-md hover:bg-gray-100 transition-colors text-gray-600"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-xl font-bold text-gray-900">Cultura Hub</span>
        </div>
        <img src="/logo.png" alt="Cultura Inglesa" className="h-8 object-contain" />
      </header>

      {/* Body below header */}
      <div className="flex flex-1 overflow-hidden">
        {/* Collapsible sidebar */}
        <nav className={`shrink-0 border-r bg-white flex flex-col gap-1 transition-all duration-200 overflow-hidden ${collapsed ? "w-0 p-0" : "w-56 p-4"}`}>
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="block rounded px-3 py-2 text-sm font-medium hover:bg-gray-100 transition-colors whitespace-nowrap text-gray-700"
            >
              {label}
            </a>
          ))}
        </nav>

        {/* Main content — scrollable */}
        <div className="flex-1 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}
