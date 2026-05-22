import { getUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import DashboardShell from "./shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  return <DashboardShell>{children}</DashboardShell>;
}
