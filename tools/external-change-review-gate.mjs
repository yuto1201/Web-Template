import {
  digestValue,
  schemas,
  validateExternalLifecycleArtifactSet,
} from "./workflow-core.mjs";
import { operationModelFamily } from "./execution-policy.mjs";

const shaPattern = /^[0-9a-f]{40}$/u;

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {unknown} value @param {string} label */
function record(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be a structured object.`);
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value @returns {boolean} */
function containsRawEmail(value) {
  if (typeof value === "string") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (Array.isArray(value)) return value.some(containsRawEmail);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => /^(?:email|loginEmail|userEmail)$/iu.test(key) || containsRawEmail(child));
  }
  return false;
}

/** @param {string} body */
export function parseExternalChanges(body) {
  const headings = [...body.matchAll(/^## External changes\s*$/gimu)];
  assert(headings.length === 1, "PR body must contain the External changes section exactly once.");
  const headingIndex = headings[0].index ?? 0;
  const prefix = body.slice(0, headingIndex);
  assert(prefix.lastIndexOf("<!--") <= prefix.lastIndexOf("-->"), "External changes must not be inside an HTML comment.");
  const start = headingIndex + headings[0][0].length;
  const tail = body.slice(start);
  const end = tail.search(/^##\s+/mu);
  const section = end === -1 ? tail : tail.slice(0, end);
  assert(!/(?:^|\n)\s{0,3}(?:`{3,}|~{3,})/u.test(section), "External changes must not be inside a fenced code block.");
  assert(!section.includes("<!--") && !section.includes("-->"), "External changes must not be inside an HTML comment.");
  const lines = section.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  assert(lines.length > 0, "External changes require either - None. or one structured Operation evidence entry.");
  if (lines.length === 1 && lines[0] === "- None.") return [];
  assert(!lines.includes("- None."), "External changes cannot combine None with operation evidence.");
  assert(lines.length === 1, "A pull request may declare at most one pre-merge external change.");
  const marker = "- Operation evidence: ";
  assert(lines[0].startsWith(marker), "External changes require structured Operation evidence lifecycle JSON.");
  let parsed;
  try {
    parsed = JSON.parse(lines[0].slice(marker.length));
  } catch {
    throw new Error("Operation evidence must be valid single-line JSON.");
  }
  assert(!containsRawEmail(parsed), "Operation evidence must not contain raw email values.");
  return [schemas.externalChangeEvidenceSchema.parse(parsed)];
}

/**
 * @param {{
 *   body: string,
 *   changedPaths: string[],
 *   headSha: string,
 *   primaryOperatorLabel: string,
 *   primaryModelFamily: string,
 *   artifactLoader?: (reference: string) => unknown,
 *   authorityLoader?: (commitSha: string) => unknown,
 *   evidenceCommit?: {headSha:string,parentSha:string,changedPaths:string[]},
 *   isAuthorityProtected?: (authorityCommitSha:string)=>boolean,
 * }} input
 */
export function validateExternalChangesAgainstCommittedState(input) {
  const changes = parseExternalChanges(input.body);
  const committedExternalPaths = input.changedPaths.filter((candidate) => candidate.startsWith("evidence/external-operations/"));
  if (changes.length === 0) {
    assert(committedExternalPaths.length === 0, "Committed external-operation artifacts are missing structured external lifecycle evidence.");
    return 0;
  }
  if (
    typeof input.artifactLoader !== "function" ||
    typeof input.authorityLoader !== "function" ||
    typeof input.isAuthorityProtected !== "function" ||
    !input.evidenceCommit
  ) {
    throw new Error("Structured external changes require committed artifact, protected-authority, and evidence-commit loaders.");
  }
  const expectedModelFamily = operationModelFamily(input.primaryModelFamily);
  assert(expectedModelFamily, "External changes require a recognized primary model family.");
  const referencedPaths = new Set();
  for (const change of changes) {
    const changeRecord = /** @type {Record<string, any>} */ (change);
    assert(change.evidenceHeadSha === input.headSha, "External change evidence Head SHA must match the current Head SHA.");
    assert(
      change.operatorLabel === input.primaryOperatorLabel && change.modelFamily === expectedModelFamily,
      "External change operator/model must match the reviewed primary implementation.",
    );
    /** @type {Record<string, Record<string, any>>} */
    const artifacts = {};
    for (const phase of ["request", "preflight", "claim", "mutation", "result", "finalized"]) {
      const binding = changeRecord[phase];
      assert(input.changedPaths.includes(binding.reference), `External change ${phase} reference must be a committed changed path.`);
      referencedPaths.add(binding.reference);
      const artifact = record(input.artifactLoader(binding.reference), `${phase} committed artifact`);
      assert(!containsRawEmail(artifact), `External change ${phase} artifact contains raw email evidence.`);
      assert(digestValue(artifact) === binding.digest, `External change ${phase} artifact digest mismatch.`);
      artifacts[phase] = artifact;
    }
    const requestArtifact = record(artifacts.request, "request committed artifact");
    const contract = record(record(requestArtifact.payload, "request lifecycle payload").contract, "request lifecycle Issue contract");
    const authorityCommitSha = String(record(contract.authority, "request lifecycle authority").commitSha ?? "");
    assert(shaPattern.test(authorityCommitSha), "Request lifecycle authority commit SHA is invalid.");
    validateExternalLifecycleArtifactSet(change, artifacts, {
      authority: input.authorityLoader(authorityCommitSha),
      evidenceCommit: input.evidenceCommit,
      isAuthorityProtected: input.isAuthorityProtected,
    });
  }
  assert(committedExternalPaths.every((candidate) => referencedPaths.has(candidate)), "Committed external-operation artifact is missing from lifecycle evidence.");
  return changes.length;
}
