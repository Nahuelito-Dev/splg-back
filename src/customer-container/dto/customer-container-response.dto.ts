import { ApiProperty } from '@nestjs/swagger';

export class CustomerContainerResponseDto {
  @ApiProperty({ format: 'uuid' })
  gasCylinderId!: string;

  @ApiProperty({ example: 'Garrafa 10 kg' })
  type!: string;

  @ApiProperty({ minimum: 0 })
  owned!: number;

  @ApiProperty({ minimum: 0 })
  loanedByM5!: number;

  @ApiProperty()
  isActive!: boolean;
}

export class CustomerContainersResponseDto {
  @ApiProperty({ type: CustomerContainerResponseDto, isArray: true })
  items!: CustomerContainerResponseDto[];
}
