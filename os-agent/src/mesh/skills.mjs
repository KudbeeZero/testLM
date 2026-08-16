/**
 * skills.mjs — KUDBEE-native skill registry (SKILL.md concept, no external dep).
 *
 * A skill describes: name, purpose, prerequisites, tools, procedure,
 * validation, failure handling, permissions. This phase seeds a couple of
 * real, verifiable engineering skills.
 */
export const SKILLS = {
  "repository-health": {
    name: "repository-health",
    purpose: "Assess repository health (git status, diff, syntax check).",
    prerequisites: [],
    tools: ["git.status", "git.diff", "project.check"],
    procedure: ["git.status", "git.diff", "project.check"],
    validation: "git.status and git.diff succeed; project.check passes on changed files",
    failureHandling: "report the failing tool result as evidence; do not modify files",
    permissions: ["git.read", "project.check"],
  },
  "test-and-diagnose": {
    name: "test-and-diagnose",
    purpose: "Run the test suite and diagnose failures with evidence.",
    prerequisites: ["repository-health"],
    tools: ["project.test", "file.read", "filesystem.search"],
    procedure: [
      "1. Inspect repository state (git.status)",
      "2. Determine the available test mechanism",
      "3. Select ONLY an allowlisted suite (bun:test or npm:test)",
      "4. Request project.test with suite=bun:test (or npm:test)",
      "5. Observe the result",
      "6. If successful, evaluate and verify",
      "7. If failed, diagnose using read-only tools (file.read / filesystem.search)",
      "8. Do not modify files",
      "9. Produce evidence",
      "10. Store validated learning",
    ],
    validation: "tests run with an allowlisted suite; failures diagnosed with evidence; no code modified",
    failureHandling: "capture test output as evidence; if MESH denies, replan with an allowlisted suite; never edit code without approval",
    permissions: ["project.test", "filesystem.read", "filesystem.search"],
  },
};

export function getSkill(name) {
  return SKILLS[name] || null;
}

export function listSkills() {
  return Object.keys(SKILLS);
}
