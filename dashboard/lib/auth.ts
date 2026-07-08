import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

export async function getUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;

  return {
    name:   session.user.name ?? "",
    email:  session.user.email ?? "",
    role:   (session.user as any).role ?? null,
    branch: "all",
  };
}

export function branchFilter(branch: string) {
  if (branch === "all") return "";
  return `AND branch = '${branch}'`;
}
