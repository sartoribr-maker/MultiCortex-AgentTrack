import type { NextConfig } from "next";

/** Internal dashboard: nothing on this host may be indexed or archived. */
export const NOINDEX = "noindex, nofollow, noarchive";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: NOINDEX }] }];
  },
};

export default nextConfig;
