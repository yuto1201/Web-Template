"use client";

import { getServerEnvironment } from "../../../../src/lib/env/server";

export default function Violation() {
  getServerEnvironment();
  return <p>This fixture must never build.</p>;
}
