import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { requireSecret } from '../../common/config/require-secret';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireSecret(
        'JWT_SECRET',
        config.get<string>('JWT_SECRET'),
      ),
    });
  }

  validate(payload: { sub: string }) {
    // The role in the token is NOT trusted for authorisation — the principal is
    // rebuilt from the database, so a role change or a deactivation takes
    // effect on the next request rather than when the token finally expires.
    return this.auth.buildPrincipal(payload.sub);
  }
}
