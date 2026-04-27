/**
 * Auth helpers — Google OAuth via NextAuth.js.
 * Branch managers see only their branch; super-admins see all.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

export type Role = "super_admin" | "branch_manager";

export interface SessionUser {
  email: string;
  name: string;
  role: Role;
  branches: string[]; // ["all"] for super_admin
}

export async function getUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  return session.user as SessionUser;
}

/** Returns a SQL WHERE clause fragment for branch filtering. */
export function branchFilter(user: SessionUser, alias = ""): string {
  const col = alias ? `${alias}.branch` : "branch";
  if (user.branches.includes("all")) return "TRUE";
  const list = user.branches.map((b) => `'${b}'`).join(", ");
  return `${col} IN (${list})`;
}
