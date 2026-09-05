import { IsString, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

class ChatMessage {
  @ApiProperty({ example: 'user', enum: ['user', 'assistant', 'system'] })
  @IsString()
  role: 'user' | 'assistant' | 'system';

  @ApiProperty({ example: 'How many leave days do I have left?' })
  @IsString()
  content: string;
}

export class ChatDto {
  @ApiProperty({
    example: 'How many leave days do I have left?',
    description: 'Message from the user',
  })
  @IsString()
  message: string;

  @ApiProperty({
    type: [ChatMessage],
    required: false,
    description: 'Chat history (optional)',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessage)
  history?: ChatMessage[];
}
