import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { BankDetailsModule } from '../bank-details/bank-details.module';
import { WpsController } from './wps.controller';
import { WpsConfigurationService } from './wps-configuration.service';
import { WpsPayloadBuilder } from './wps-payload.builder';
import { WpsPreflightService } from './wps-preflight.service';
import { WpsGenerationService } from './wps-generation.service';
import { WpsFilesService } from './wps-files.service';
import { WpsFileDownloadResolver } from './wps-download.resolver';
import { WpsFormatRegistry } from './formats/wps-format.registry';
import { OmanCboFormat } from './formats/oman-cbo.format';
import { OmanSifEdrFormat } from './formats/oman-sif-edr.format';
import { GenericCsvFormat } from './formats/generic-csv.format';

/**
 * Wage Protection System — generates the salary instruction file an employer
 * uploads to their bank.
 *
 * Adding a country: implement WpsFormat, add it to `providers` below and to
 * WpsFormatRegistry's constructor. Nothing else changes — the settings form, the
 * pre-flight, the generator, the download route and the audit trail are all
 * format-agnostic.
 *
 * Deliberately does NOT import DocumentVaultModule: that module registers the
 * secure-download resolver array and imports this one, so importing it back would
 * create a cycle. WpsFileDownloadResolver is exported for it to pick up.
 */
@Module({
  imports: [PrismaModule, AuditModule, StorageModule, BankDetailsModule],
  controllers: [WpsController],
  providers: [
    OmanCboFormat,
    OmanSifEdrFormat,
    GenericCsvFormat,
    WpsFormatRegistry,
    WpsConfigurationService,
    WpsPayloadBuilder,
    WpsPreflightService,
    WpsGenerationService,
    WpsFilesService,
    WpsFileDownloadResolver,
  ],
  exports: [
    WpsFormatRegistry,
    WpsFilesService,
    WpsFileDownloadResolver,
    WpsGenerationService,
  ],
})
export class WpsModule {}
