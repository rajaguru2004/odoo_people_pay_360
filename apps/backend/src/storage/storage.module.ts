import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';

/**
 * Storage stays dependency-free on purpose. The authenticated download route
 * (`SecureDownloadController`) lives in DocumentVaultModule instead, because it
 * needs the per-kind resolvers — and letters/vault already depend on storage, so
 * registering them here would close a cycle.
 */
@Module({
  imports: [ConfigModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
