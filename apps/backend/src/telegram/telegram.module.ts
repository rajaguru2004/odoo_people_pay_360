import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegramApiClient } from './api/telegram-api.client';
import { TelegramController, TelegramMeController } from './telegram.controller';
import { TelegramOutboxService } from './telegram-outbox.service';
import { TelegramSettingsService } from './telegram-settings.service';
import { TelegramIdentityService } from './identity/telegram-identity.service';
import { IpGeoService } from './login-alerts/ip-geo.service';
import { LoginAlertService } from './login-alerts/login-alert.service';

/**
 * Telegram channel — OUTBOUND half (notifications, login alerts, identity, admin).
 *
 * Same import discipline as WhatsAppModule and DiscordModule, and for the same
 * reason: NotificationsModule imports this for the delivery tee, and ~20 domain
 * modules import NotificationsModule. Depending only on PrismaModule and
 * AuditModule keeps this edge cycle-free.
 *
 * AuthModule also imports this, for LoginAlertService. That direction is safe
 * precisely because nothing here imports AuthModule — the two controllers use
 * JwtAuthGuard as a class, not as a module dependency, exactly as the Discord
 * controllers do.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [TelegramController, TelegramMeController],
  providers: [
    TelegramSettingsService,
    TelegramApiClient,
    TelegramIdentityService,
    TelegramOutboxService,
    IpGeoService,
    LoginAlertService,
  ],
  exports: [
    TelegramSettingsService,
    TelegramApiClient,
    TelegramIdentityService,
    TelegramOutboxService,
    LoginAlertService,
  ],
})
export class TelegramModule {}
