import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateCylinderDto {
  /** Número de serie físico grabado en el envase. */
  @IsString()
  serial: string;

  @IsOptional()
  @IsUUID()
  gasCylinderId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deposit?: number;
}
