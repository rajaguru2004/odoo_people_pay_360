import { IsString, IsOptional, IsEnum } from 'class-validator';

export enum DocumentType {
  AVATAR = 'AVATAR',
  RESUME = 'RESUME',
  ID_CARD_FRONT = 'ID_CARD_FRONT',
  ID_CARD_BACK = 'ID_CARD_BACK',
  DEGREE = 'DEGREE',
  CERTIFICATE = 'CERTIFICATE',
  CONTRACT = 'CONTRACT',
  OTHER = 'OTHER',
}

export class UploadDocumentDto {
  @IsEnum(DocumentType)
  documentType: DocumentType;

  @IsOptional()
  @IsString()
  description?: string;
}
