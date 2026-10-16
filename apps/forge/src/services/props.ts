// What a grant carries for its lifetime (encrypted by the OAuth provider). One grant = one agent.
export interface AgentProps extends Record<string, unknown> {
  humanId: string;
  agentId: string;
  githubLogin: string;
  /** Public GitHub organisations at sign-in, lowercased; used for the publisher rule. */
  githubOrgs: string[];
}
