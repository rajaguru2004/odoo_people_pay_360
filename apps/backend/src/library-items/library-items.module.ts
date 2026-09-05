import { Module } from '@nestjs/common';
import { LibraryItemsService } from './library-items.service';
import { LibraryItemsController } from './library-items.controller';

@Module({
  controllers: [LibraryItemsController],
  providers: [LibraryItemsService],
  exports: [LibraryItemsService],
})
export class LibraryItemsModule {}
