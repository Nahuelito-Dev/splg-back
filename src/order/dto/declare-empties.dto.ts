import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class DeclareEmptiesItemDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  gasCylinderId!: string;

  @ApiProperty({ type: Number, minimum: 0, example: 1 })
  @IsInt()
  @Min(0)
  emptiesReceived!: number;
}

export class DeclareEmptiesDto {
  @ApiProperty({ type: [DeclareEmptiesItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: DeclareEmptiesItemDto) => item.gasCylinderId)
  @ValidateNested({ each: true })
  @Type(() => DeclareEmptiesItemDto)
  items!: DeclareEmptiesItemDto[];
}
