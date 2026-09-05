import { GarnishmentsModule } from '../garnishments/garnishments.module';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { EmployeeActivityService } from './employee-activity.service';
import { PeopleHubService } from './people-hub.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { MailModule } from '../mail/mail.module';
import { SystemSettingsModule } from '../system-settings/system-settings.module';
import { ProfileTemplatesModule } from '../profile-templates/profile-templates.module';
import { SupervisorsModule } from '../supervisors/supervisors.module';
import { ContractsModule } from '../contracts/contracts.module';
import { AssetsModule } from '../assets/assets.module';
import { memoryStorage } from 'multer';
import { existsSync, mkdirSync } from 'fs';

// Local dirs kept only for transient Excel imports (parsed then discarded) and
// for serving legacy files uploaded before the MinIO migration.
const uploadDirs = ['./uploads', './uploads/imports'];
uploadDirs.forEach((dir) => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

@Module({
  imports: [GarnishmentsModule, 
    PrismaModule,
    StorageModule,
    MailModule,
    SystemSettingsModule,
    // ClearanceService — soft-delete is an offboarding path too.
    AssetsModule,
    // Resolves which employee-form template governs a write.
    ProfileTemplatesModule,
    // Owns the supervisor-assignment invariants the employee form delegates to.
    SupervisorsModule,
    // The People hub reuses ContractsService for contract statistics and the
    // expiry countdown rather than writing a second copy of either.
    ContractsModule,
    // Default: buffer in memory — persistent files go through StorageService
    // (MinIO S3). Endpoints needing a temp file (Excel import) override this.
    MulterModule.register({
      storage: memoryStorage(),
    }),
  ],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeActivityService, PeopleHubService],
  exports: [EmployeesService, EmployeeActivityService, PeopleHubService],
})
export class EmployeesModule {}
