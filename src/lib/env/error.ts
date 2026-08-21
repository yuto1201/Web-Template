import type { ZodIssue } from "zod";

export class EnvironmentConfigurationError extends Error {
  readonly scope: "public" | "server";
  readonly variables: readonly string[];

  constructor(scope: "public" | "server", issues: readonly ZodIssue[]) {
    const variables = [...new Set(
      issues.map((issue) => String(issue.path[0] ?? "environment")),
    )].sort();
    super(`Invalid ${scope} environment configuration: ${variables.join(", ")}.`);
    this.name = "EnvironmentConfigurationError";
    this.scope = scope;
    this.variables = variables;
  }
}
