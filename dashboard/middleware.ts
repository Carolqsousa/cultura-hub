import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { canAccess, firstAllowedPage } from "./lib/permissions";

export async function middleware(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  if (!token) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  const role = token.role as string | null;

  if (!canAccess(role, req.nextUrl.pathname)) {
    const landing = firstAllowedPage(role);
    if (landing === req.nextUrl.pathname) {
      return NextResponse.next(); // avoid a redirect loop in the edge case
    }
    return NextResponse.redirect(new URL(landing, req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
