import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';

export class CreateContainerAdjustmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ minimum: -1000, maximum: 1000, example: 2 })
  @IsInt()
  @Min(-1000)
  @Max(1000)
  @NotEquals(0)
  quantity!: number;

  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'Corrección por inventario inicial.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  note!: string;
}
