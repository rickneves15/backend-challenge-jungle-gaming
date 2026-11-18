/**
 * ProviderIdentityPort — abstraction for resolving the identity of a game
 * provider from an external Identity Provider (IdP).
 *
 * This is an explicit extension point for authentication. The challenge does
 * not require authentication (it is not scored), so this port is intentionally
 * left without a production implementation. When authentication is prioritized,
 * implement this port against an external IdP (e.g. Keycloak, Zitadel) and bind
 * it in the module providers (useExisting / useClass).
 *
 * The service never stores users or password hashes locally.
 */
export interface ProviderIdentityPort {
  /**
   * Resolves and validates the provider identity from an external IdP token.
   * Returns the provider identifier if the token is valid, or throws if the
   * identity cannot be established.
   */
  resolveProviderId(token: string): Promise<string>;

  /**
   * Validates that a provider is allowed to perform operations on behalf of a
   * given player (optional, depending on the IdP model).
   */
  isProviderAuthorizedForPlayer(
    providerId: string,
    playerId: string,
  ): Promise<boolean>;
}
