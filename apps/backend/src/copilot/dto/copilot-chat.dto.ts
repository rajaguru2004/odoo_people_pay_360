import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CopilotChatDto {
  @ApiProperty({ example: 'Who is on leave today?', maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message: string;

  @ApiProperty({ required: false, description: 'Continue an existing conversation' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
