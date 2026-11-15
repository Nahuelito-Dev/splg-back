import { BadRequestException, PipeTransform } from '@nestjs/common';
import { conCodigo } from '../../common/errors/con-codigo';
import { TRACE_ID_VALIDO } from '../../common/traza/contexto-de-traza';

/**
 * Un id de traza válido: de 1 a 64 caracteres con letras, dígitos, `-` o `_`
 * (la misma regla con que se acepta el `X-Request-Id` entrante). Si no, 400
 * `INVALID_TRACE_ID`.
 */
export class ParseTraceIdPipe implements PipeTransform<unknown, string> {
  transform(valor: unknown): string {
    if (typeof valor === 'string' && TRACE_ID_VALIDO.test(valor)) return valor;
    throw conCodigo(
      BadRequestException,
      400,
      'El id de traza tiene que tener de 1 a 64 caracteres: letras, números, guiones o guiones bajos',
      'INVALID_TRACE_ID',
    );
  }
}
