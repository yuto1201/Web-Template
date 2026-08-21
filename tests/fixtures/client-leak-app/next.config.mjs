import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  turbopack: {
    root: path.resolve(fixtureDirectory, "../../.."),
  },
};

export default nextConfig;
