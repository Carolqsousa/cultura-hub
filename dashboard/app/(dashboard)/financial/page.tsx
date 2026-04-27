import { getUser } from "@/lib/auth";
import { getMonthlyRevenue, getDelinquency } from "@/lib/queries/financials";
import { redirect } from "next/navigation";

export default async function FinancialPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const [revenue, delinquency] = await Promise.all([
    getMonthlyRevenue(user),
    getDelinquency(user),
  ]);

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-6">Financial</h1>
      <pre className="text-xs">{JSON.stringify({ revenue, delinquency }, null, 2)}</pre>
    </main>
  );
}
