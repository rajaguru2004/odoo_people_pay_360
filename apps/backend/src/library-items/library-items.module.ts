import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LibraryItemsController } from './library-items.controller';
import { LibraryItemsService } from './library-items.service';

@Module({
  imports: [PrismaModule],
  controllers: [LibraryItemsController],
  providers: [LibraryItemsService],
  exports: [LibraryItemsService],
})
export class LibraryItemsModule {}
