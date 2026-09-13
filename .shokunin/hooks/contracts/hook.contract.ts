export type CanonicalHookEvent =
  | 'repo:session-open'
  | 'repo:pre-action'
  | 'repo:post-action'
  | 'repo:zone-seal'
  | 'repo:session-end';

export type HookVerdict =
  | {
      readonly verdict: 'ALLOW';
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly verdict: 'BLOCK';
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly remediation: string;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };

export interface HookEnvelope {
  readonly event: CanonicalHookEvent;
  readonly actor: 'codex' | 'gemini' | 'claude-code';
  readonly projectRoot: string;
  readonly nativePayload: Readonly<Record<string, unknown>>;
}
