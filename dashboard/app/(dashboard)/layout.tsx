import { getUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="h-14 border-b flex items-center justify-end px-6 shrink-0">
        <img src="/logo.png" alt="Cultura Inglesa" className="h-8 object-contain" />
      </header>
      <div className="flex flex-1 overflow-hidden">
      <nav className="w-56 shrink-0 border-r p-4 flex flex-col gap-1">
        <NavLink href="/">Overview</NavLink>
        <NavLink href="/students">Students</NavLink>
        <NavLink href="/financial">Financial</NavLink>
        <NavLink href="/teachers">Teachers</NavLink>
        <NavLink href="/comercial">Comercial</NavLink>
        <NavLink href="/todos">To-Do</NavLink>
        <NavLink href="/quality">Quality</NavLink>
      </nav>
      <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="block rounded px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
    >
      {children}
    </a>
  );
}
