import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { VacioANulo } from '../../employee/dto/vacio-a-nulo.decorator';
import {
  CreateTrafficFineDto,
  TrafficFineResponseDto,
  UpdateTrafficFineDto,
} from './traffic-fine.dto';

const ENLACE_HTTPS = /^https:\/\/[^\s]+$/;

/** Enlace y código de pago de la multa (los comparten el alta y la edición v2). */
class DatosDePagoDeLaMulta {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://pagos.posadas.gob.ar/multas/A-0012345',
    maxLength: 500,
    description:
      'Enlace de pago (https): portal del municipio o Mercado Pago. El panel lo abre en otra pestaña',
  })
  @VacioANulo()
  @IsOptional()
  @MaxLength(500)
  @Matches(ENLACE_HTTPS, { message: 'paymentUrl: tiene que ser una URL https' })
  paymentUrl?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0123456789012345',
    maxLength: 80,
    description: 'Código de pago que pide el portal',
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  paymentCode?: string | null;
}

export class CreateTrafficFineV2Dto extends IntersectionType(
  CreateTrafficFineDto,
  DatosDePagoDeLaMulta,
) {}

export class UpdateTrafficFineV2Dto extends IntersectionType(
  UpdateTrafficFineDto,
  DatosDePagoDeLaMulta,
) {}

export class PayTrafficFineV2Dto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Comprobante subido con `POST /traffic-fines/:id/receipt` (adjunto de esa multa)',
  })
  @IsUUID()
  attachmentId!: string;

  @ApiProperty({
    type: String,
    example: '2026-10-28T14:30:00-03:00',
    description:
      'Cuándo se pagó (fecha o fecha y hora ISO 8601); no puede ser futura ni anterior a la infracción',
  })
  @IsISO8601({ strict: true })
  paidAt!: string;

  @ApiProperty({
    example: 59500,
    description:
      'Lo efectivamente pagado (suele ser el del pago voluntario); no puede superar el importe de la multa',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '88123456',
    maxLength: 60,
  })
  @VacioANulo()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  operationNumber?: string | null;

  @ApiProperty({
    format: 'uuid',
    description:
      'Caja de la que sale el pago: efectivo, banco o billetera de la distribuidora',
  })
  @IsUUID()
  cashBoxId!: string;
}

export class TrafficFineV2ResponseDto extends TrafficFineResponseDto {
  @ApiProperty({ type: String, nullable: true })
  paymentUrl!: string | null;
  @ApiProperty({ type: String, nullable: true })
  paymentCode!: string | null;
  @ApiProperty({ type: String, nullable: true })
  operationNumber!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Comprobante del pago; `null` en las multas pagadas por la v1 (sin comprobante)',
  })
  receiptAttachmentId!: string | null;
}

export class TrafficFineV2PageDto {
  @ApiProperty({ type: TrafficFineV2ResponseDto, isArray: true })
  data!: TrafficFineV2ResponseDto[];
  @ApiProperty({ example: 4 }) total!: number;
}
