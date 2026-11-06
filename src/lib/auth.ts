import { BASE_PATH } from "@/lib/base-path";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyDevcoreUser } from "@/lib/devcore/users";
import { crmAuthEnabled, loginCrmAdmin } from "@/lib/devcore/crm-auth";

/**
 * CRM mode validates the CRM credentials and current Admin account.
 * Local credentials remain available only for isolated/legacy deployments.
 * The session is an encrypted JWT in a cookie of this host only.
 * Needs AUTH_SECRET and, in production, AUTH_URL=https://devcore.multicortex.com.br.
 */
export const { auth, signIn, signOut } = NextAuth({
  // Behind the EC2 nginx, which sets Host and X-Forwarded-Proto.
  trustHost: true,
  ...(BASE_PATH ? {
    basePath: BASE_PATH + "/api/auth",
    cookies: {
      sessionToken: {
        name: "__Secure-agenttrack.session-token",
        options: { httpOnly: true, sameSite: "lax" as const, path: BASE_PATH, secure: true },
      },
      csrfToken: {
        name: "__Secure-agenttrack.csrf-token",
        options: { httpOnly: true, sameSite: "lax" as const, path: BASE_PATH, secure: true },
      },
      callbackUrl: {
        name: "__Secure-agenttrack.callback-url",
        options: { httpOnly: true, sameSite: "lax" as const, path: BASE_PATH, secure: true },
      },
    },
  } : {}),
  session: { strategy: "jwt", ...(crmAuthEnabled() ? { maxAge: 15 * 60 } : {}) },
  callbacks: {
    jwt({ token, user }) {
      if (user && "crmAccessToken" in user && "crmExpiresAt" in user) {
        token.crmAccessToken = user.crmAccessToken;
        token.crmExpiresAt = user.crmExpiresAt;
      }
      return token;
    },
    // The default public session projection deliberately omits CRM token claims.
  },
  pages: { signIn: BASE_PATH + "/entrar" },
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
        if (crmAuthEnabled()) {
          const user = await loginCrmAdmin(email, password);
          return user ? { id: user.id, email: user.email, name: user.name,
            crmAccessToken: user.accessToken, crmExpiresAt: user.expiresAt } : null;
        }
        const user = await verifyDevcoreUser(email, password);
        return user ? { id: user.email, email: user.email, name: user.name } : null;
      },
    }),
  ],
});
