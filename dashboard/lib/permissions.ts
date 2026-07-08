export const ROLE_PAGES: Record<string, string[]> = {
  "Super Admin": ["*"],
  "Manager":     ["/", "/financial", "/students", "/teachers", "/comercial", "/commercial-natal", "/quality", "/todos"],
  "ACD":         ["/students", "/teachers", "/quality"],
  "Front Desk":  ["/", "/financial", "/students", "/teachers", "/comercial", "/commercial-natal", "/quality"],
};

export function canAccess(role: string | undefined | null, path: string): boolean {
  if (!role) return false;
  const allowed = ROLE_PAGES[role];
  if (!allowed) return false;
  return allowed.includes("*") || allowed.includes(path);
}
