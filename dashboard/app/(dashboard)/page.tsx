import { getUser } from "@/lib/auth";
import { redirect } from "next/navigation";

// Overview page — one card per branch
export default async function OverviewPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-6">Overview</h1>
      {/* Branch cards go here — implement when BigQuery is wired */}
      <p className="text-muted-foreground">Loading branch summaries…</p>
    </main>
  );
}
