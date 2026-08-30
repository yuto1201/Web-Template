import { describe, expect, it } from "vitest";
import { parseExternalChanges } from "../tools/external-change-review-gate.mjs";

/** @param {string} external */
function body(external) {
  return `Closes #33\n\n## Cross-model review\n- placeholder\n\n## External changes\n${external}\n\n## Remaining work\n- None.\n`;
}

describe("account-bound GitHub external-change section", () => {
  it("accepts an explicit no-change declaration", () => {
    expect(parseExternalChanges(body("- None."))).toEqual([]);
  });

  it("fails closed when the section is blank or ambiguous", () => {
    expect(() => parseExternalChanges(body(""))).toThrow("External changes require either - None. or one structured Operation evidence entry.");
    expect(() => parseExternalChanges(body("- None.\n- Operation evidence: {}"))).toThrow(/cannot combine None/u);
  });

  it("rejects malformed, free-form, or secret-bearing operation evidence", () => {
    expect(() => parseExternalChanges(body("- changed production"))).toThrow(/structured Operation evidence/u);
    expect(() => parseExternalChanges(body("- Operation evidence: {"))).toThrow(/valid single-line JSON/u);
    expect(() => parseExternalChanges(body('- Operation evidence: {"email":"operator@example.invalid"}'))).toThrow(/raw email/u);
  });
});
