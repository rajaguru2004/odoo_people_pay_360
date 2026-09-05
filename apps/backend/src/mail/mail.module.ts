import { Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
// Deep into `dist/`, which is where the adapter actually lives. v2.0.2 ships no
// `exports` map and no root-level `adapters/` re-export stubs — the package root
// only re-exports `dist/index`, which does NOT include the adapters. So
// `@nestjs-modules/mailer/adapters/handlebars.adapter` resolves to nothing under
// `moduleResolution: nodenext` and fails the build.
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { existsSync } from 'fs';
import { MailService } from './mail.service';
import { SystemSettingsModule } from '../system-settings/system-settings.module';

@Module({
  imports: [
    SystemSettingsModule,
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        transport: {
          host: configService.get('MAIL_HOST', 'smtp.gmail.com'),
          port: configService.get('MAIL_PORT', 587),
          secure: false, // true for 465, false for other ports
          auth: {
            user: configService.get('MAIL_USER'),
            pass: configService.get('MAIL_PASSWORD'),
          },
        },
        defaults: {
          from: `"${configService.get('MAIL_FROM_NAME', 'HR System')}" <${configService.get('MAIL_FROM', 'noreply@company.com')}>`,
        },
        template: {
          dir: existsSync(join(__dirname, 'templates'))
            ? join(__dirname, 'templates')
            : join(__dirname, '../../mail/templates'),
          adapter: new HandlebarsAdapter(),
          options: {
            strict: true,
          },
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
