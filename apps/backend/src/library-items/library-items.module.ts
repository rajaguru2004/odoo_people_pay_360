import { Module } from '@nestjs/common';
import { LibraryItemsController } from './library-items.controller';
import { LibraryItemsService } from './library-items.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [LibraryItemsController],
  providers: [LibraryItemsService],
  exports: [LibraryItemsService],
})
export class LibraryItemsModule {}
