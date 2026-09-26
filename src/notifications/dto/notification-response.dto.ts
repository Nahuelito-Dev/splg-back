import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Resultado de mandar un push o de registrar un token. Nunca lanza. */
export class ResultadoDeEnvioDto {
  @ApiProperty() success!: boolean;
  @ApiPropertyOptional({ description: 'Id del mensaje en FCM' })
  messageId?: string;
  @ApiPropertyOptional({ example: 'No notification token' }) error?: string;
}

export class TokensDeUsuarioDto {
  @ApiProperty({ type: String, isArray: true }) tokens!: string[];
}
