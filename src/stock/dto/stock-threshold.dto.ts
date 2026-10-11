import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ThresholdItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({
    example: 20,
    description: 'Mínimo de llenas. 0 desactiva el aviso de ese par.',
  })
  @IsInt()
  @Min(0)
  @Max(100_000)
  minFull!: number;
}

export class UpsertThresholdsDto {
  @ApiProperty({ type: ThresholdItemDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ThresholdItemDto)
  thresholds!: ThresholdItemDto[];
}
