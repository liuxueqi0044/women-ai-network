/**
 * The AuthProvider contract as the compliance harness sees it.
 *
 * Declared here (testkit) so the shared suite has no dependency on the API
 * package; the API's own `AuthProvider` port (apps/api/src/account/ports.ts)
 * declares the same shape — TypeScript structural typing enforces
 * compatibility at the compliance call site in compliance.spec.ts.
 */
export interface AuthProvider {
  readonly name: string;
  hashPassword(password: string): Promise<string>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  dummyVerify(password: string): Promise<void>;
  generateTotpSecret(): string;
  createTotpUri(secret: string, accountId: string, email: string): string;
  verifyTotp(secret: string, code: string, atSeconds: number): boolean;
}
