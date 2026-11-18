import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';

/**
 * NoOpAuthGuard — explicit authentication extension point.
 *
 * Authentication is not implemented in this challenge (it does not count
 * toward the score, per section 2). This guard is a no-op that allows requests
 * to proceed without validating an IdP token.
 *
 * When authentication is prioritized, replace this guard (or register a real
 * JWT/OIDC strategy) and bind it globally or per-controller:
 *
 *   @UseGuards(NoOpAuthGuard)   // today: allows all
 *   // @UseGuards(JwtAuthGuard)  // future: validates IdP access token
 *
 * Health endpoints remain open regardless of this guard.
 */
@Injectable()
export class NoOpAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Intentionally allow all requests. No token validation is performed.
    return true;
  }
}
