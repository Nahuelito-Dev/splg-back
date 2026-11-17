import type { TiempoEsperado } from '../domain/tiempo-de-respuesta';
import type { ExpectedReplyResponseDto } from './dto/bandeja-response.dto';

export function tiempoEsperadoADto(
  t: TiempoEsperado,
): ExpectedReplyResponseDto {
  return {
    enabled: t.enabled,
    openNow: t.openNow,
    minutes: t.minutes,
    basis: t.basis,
    nextOpenAt: t.nextOpenAt?.toISOString() ?? null,
    text: t.text,
  };
}
