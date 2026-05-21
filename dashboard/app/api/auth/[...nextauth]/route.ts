import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";

const handler = NextAuth({
  providers: [
    GoogleProvider({
      clientId:     process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      // Only allow @culturainglesane.com.br emails
      const email = (profile as any)?.email || "";
      return email.endsWith("@culturainglesane.com.br");
    },
    async session({ session, token }) {
      return session;
    },
  },
  pages: {
    signIn:  "/login",
    error:   "/login",
  },
});

export { handler as GET, handler as POST };
