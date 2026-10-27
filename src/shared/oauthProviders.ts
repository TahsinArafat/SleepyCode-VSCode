// Shim: SleepyCode does not use the upstream multi-provider OAuth.
// Kept as empty stubs so the imported webview-ui compiles.
export const OAUTH_PROVIDER_DEFINITIONS: any[] = [];
export type OAuthProviderKind = string;
export function supportsOAuthQuota(_kind: any): boolean { return false; }
