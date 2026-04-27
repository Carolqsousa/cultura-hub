"use client";

import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-6 rounded-xl border p-10 shadow-sm">
        <h1 className="text-2xl font-semibold">Cultura Hub</h1>
        <p className="text-sm text-muted-foreground">Sign in to access the dashboard</p>
        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          className="flex items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-medium hover:bg-accent transition-colors"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
