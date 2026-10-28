import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { FechaCalendarioOpcional } from '../../employee/dto/fecha-calendario.decorator';
import { DownloadDisposition } from '../../s3/dto/download-link.dto';

/** Cómo se entrega el PDF: se muestra en el navegador o se baja. */
export class PdfQueryDto {
  @ApiProperty({
    enum: DownloadDisposition,
    enumName: 'DownloadDisposition',
    required: false,
    description:
      '`attachment` (por defecto) baja el PDF; `inline` lo muestra en el navegador.',
  })
  @IsOptional()
  @IsEnum(DownloadDisposition)
  disposicion?: DownloadDisposition;
}

/** Período del reporte de ventas, en días de hora argentina (`hasta` inclusive). */
export class ReporteDeVentasPdfQueryDto extends PdfQueryDto {
  @FechaCalendarioOpcional('2026-10-01', undefined)
  desde?: string;

  @FechaCalendarioOpcional('2026-10-31', undefined)
  hasta?: string;
}
