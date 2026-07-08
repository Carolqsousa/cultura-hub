import NextAuth, { type NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId:     process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      // Only allow @culturainglesane.com.br emails
      const email = (profile as any)?.email || "";
      return email.endsWith("@culturainglesane.com.br");
    },
    async jwt({ token, profile }) {
      if (profile) {
        const email = (profile as any).email;
        const { data, error } = await supabaseAdmin
          .from("user_permissions")
          .select("role, name")
          .eq("email", email)
          .single();

        if (error) {
          console.error("[auth] permission lookup failed for", email, error.message);
        }

        token.email = email;
        token.role  = data?.role ?? null;
        token.name  = data?.name ?? profile.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.email = token.email as string;
        session.user.name  = token.name as string;
        (session.user as any).role = token.role ?? null;
      }
      return session;
    },
  },
  pages: {
    signIn:  "/login",
    error:   "/login",
  },
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
