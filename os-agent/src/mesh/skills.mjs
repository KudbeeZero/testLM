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
    procedure: ["project.test", "file.read"],
    validation: "tests run; failures diagnosed with a bounded, evidence-backed conclusion",
    failureHandling: "capture test output as evidence; do not edit code without approval",
    permissions: ["project.test", "filesystem.read", "filesystem.search"],
  },
};

export function getSkill(name) {
  return SKILLS[name] || null;
}

export function listSkills() {
  return Object.keys(SKILLS);
}
