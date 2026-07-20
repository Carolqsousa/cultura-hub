export const ROLE_PAGES: Record<string, string[]> = {
  "Super Admin": ["*"],
  "Manager":     ["/", "/financial", "/students", "/teachers", "/commercial", "/commercial-natal", "/quality", "/todos"],
  "ACD":         ["/students", "/teachers", "/quality"],
  "Front Desk":  ["/", "/financial", "/students", "/teachers", "/commercial", "/commercial-natal", "/quality"],
};

export function canAccess(role: string | undefined | null, path: string): boolean {
  if (!role) return false;
  const allowed = ROLE_PAGES[role];
  if (!allowed) return false;
  return allowed.includes("*") || allowed.includes(path);
}

export function firstAllowedPage(role: string | undefined | null): string {
  if (!role) return "/login";
  const allowed = ROLE_PAGES[role];
  if (!allowed || allowed.length === 0) return "/no-access";
  if (allowed.includes("*")) return "/";
  return allowed[0];
}

// Maps an API route back to the page it serves, so middleware can check
// permission against the PAGE the data belongs to, not the API path itself.
const API_TO_PAGE: Record<string, string> = {
  "/api/overview":         "/",
  "/api/students":         "/students",
  "/api/financial":        "/financial",
  "/api/teachers":         "/teachers",
  "/api/commercial":       "/commercial",
  "/api/commercial-natal": "/commercial-natal",
  "/api/quality":          "/quality",
  "/api/renewal":          "/quality",
  "/api/todos":            "/todos",
};

export function resolvePathForAccessCheck(pathname: string): string {
  if (!pathname.startsWith("/api/")) return pathname;
  for (const [apiPrefix, page] of Object.entries(API_TO_PAGE)) {
    if (pathname === apiPrefix || pathname.startsWith(apiPrefix + "/")) {
      return page;
    }
  }
  return pathname; // unmapped API route — falls through to normal (likely denied) check
}