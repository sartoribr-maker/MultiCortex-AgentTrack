import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyDevcoreUser } from "@/lib/devcore/users";

/**
 * Dashboard login: e-mail and password of the team members in DEVCORE_USERS.
 * No database; the session is a JWT in a cookie of this host only.
 * Needs AUTH_SECRET and, in production, AUTH_URL=https://devcore.multicortex.com.br.
 */
export const { auth, signIn, signOut } = NextAuth({
  // Behind the EC2 nginx, which sets Host and X-Forwarded-Proto.
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/entrar" },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "E-mail", type: "email" },
        password: { label: "Senha", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string" || !email || !password) return null;
        const user = await verifyDevcoreUser(email, password);
        return user ? { id: user.email, email: user.email, name: user.name } : null;
      },
    }),
  ],
});
