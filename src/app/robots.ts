import type { MetadataRoute } from "next";

/** Internal dashboard: no crawler may index any path. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
