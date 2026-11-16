import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EmailCambiadoResponseDto {
  @ApiProperty() message!: string;
  @ApiProperty({ example: 'nuevo@splg.com' }) newEmail!: string;
}

export class EstadoDeCacheDto {
  @ApiProperty() cacheEnabled!: boolean;
  @ApiProperty() resetLinksEqual!: boolean;
}

export class PruebaDeEmailResponseDto {
  @ApiProperty() success!: boolean;
  @ApiProperty() message!: string;
  @ApiPropertyOptional() emailSent?: boolean;
  @ApiPropertyOptional({ example: 'sent' }) resendStatus?: string;
  @ApiPropertyOptional({ type: EstadoDeCacheDto })
  cacheStats?: EstadoDeCacheDto;
}
