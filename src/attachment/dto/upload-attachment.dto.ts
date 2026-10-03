import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Los campos de texto del multipart; el archivo va en el campo `file`. */
export class UploadAttachmentDto {
  @ApiPropertyOptional({ maxLength: 80, example: 'DNI frente' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}
