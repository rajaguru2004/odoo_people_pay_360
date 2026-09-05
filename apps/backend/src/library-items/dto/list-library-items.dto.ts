import { ApiPropertyOptional } from '@nestjs/swagger';
import { LibraryType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

export class ListLibraryItemsDto {
  @ApiPropertyOptional({ enum: LibraryType })
  @IsOptional()
  @IsEnum(LibraryType)
  type?: LibraryType;

  @ApiPropertyOptional({
    description:
      'true = only selectable rows. Omitted returns both, which is what an ' +
      'administrator editing the list needs to see.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : undefined,
  )
  @IsBoolean()
  activeOnly?: boolean;
}
