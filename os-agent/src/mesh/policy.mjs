/**
 * policy.mjs — MESH capability + risk model.
 *
 * Defines the explicit tool→capability→risk mapping. The first version is
 * intentionally conservative: only read-only (L0) and local-reversible (L1)
 * operations are permitted. Everything higher is denied or requires approval.
 *
 * Tools are addressed by a structured `tool` name + `arguments` object — never
 * by an arbitrary shell command string.
 */

export const RISK = {
  L0: "read-only",
  L1: "local-reversible",
  L2: "local-mutation",
  L3: "external-mutation",
  L4: "production",
};
export const RISK_LEVEL = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

export const riskLevel = (r) => RISK_LEVEL[r] ?? 99;

// Highest risk level this phase permits (read-only + local-reversible only).
export const MAX_ALLOWED_RISK = "L1";

/**
 * Tool → { capability, risk, approval }.
 * `approval: true` marks tools that require a future human-approval boundary.
 */
export const TOOL_POLICY = {
  "file.read": { capability: "filesystem.read", risk: "L0", approval: false },
  "filesystem.list": { capability: "filesystem.list", risk: "L0", approval: false },
  "filesystem.search": { capability: "filesystem.search", risk: "L0", approval: false },
  "git.status": { capability: "git.read", risk: "L0", approval: false },
  "git.diff": { capability: "git.read", risk: "L0", approval: false },
  "project.check": { capability: "project.check", risk: "L0", approval: false },
  "project.test": { capability: "project.test", risk: "L1", approval: false },
};

// Future capabilities (NOT enabled this phase).
export const FUTURE_CAPABILITIES = [
  "filesystem.write",
  "git.write",
  "package.install",
  "network.request",
  "deployment",
  "aws.read",
  "aws.write",
  "database.read",
  "database.write",
];

/**
 * Agent → capability set (MESH capability model).
 * A local operator / HERMES gets only the read-only + local-reversible tool
 * capabilities. Nothing destructive is granted.
 */
export const AGENT_CAPABILITIES = {
  "local-operator": [
    "filesystem.read",
    "filesystem.list",
    "filesystem.search",
    "git.read",
    "project.check",
    "project.test",
  ],
  hermes: [
    "filesystem.read",
    "filesystem.list",
    "filesystem.search",
    "git.read",
    "project.check",
    "project.test",
  ],
};

export function agentHasCapability(agentId, capability) {
  const caps = AGENT_CAPABILITIES[agentId] || [];
  return caps.includes(capability);
}
