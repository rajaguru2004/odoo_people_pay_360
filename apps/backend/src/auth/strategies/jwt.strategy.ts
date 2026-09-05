import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';
import { requireSecret } from '../../common/config/require-secret';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireSecret(
        'JWT_SECRET',
        configService.get('JWT_SECRET'),
      ),
    });
  }

  /**
   * The principal query lives in AuthService.buildPrincipal so non-HTTP entry
   * points get an identical `req.user` — a tool call must not have weaker
   * scope because it arrived over a different transport.
   */
  async validate(payload: any) {
    return this.auth.buildPrincipal(payload.sub, payload.departmentId);
  }
}
