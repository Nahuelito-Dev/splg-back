import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { CoverageZoneSurchargeType } from '../entities/coverage-zone.entity';

/** El `surchargeType` del mismo objeto, o el default de la columna si no vino. */
function tipoDe(objeto: unknown): CoverageZoneSurchargeType {
  const tipo = (objeto as { surchargeType?: CoverageZoneSurchargeType })
    .surchargeType;
  return tipo ?? CoverageZoneSurchargeType.PERCENTAGE;
}

/**
 * Valida `surchargeValue` según el `surchargeType` del mismo objeto: un
 * recargo `percentage` tiene que estar entre 0 y 100; uno `fixed` sólo no
 * puede ser negativo.
 *
 * No se usa `@ValidateIf` porque esa condición desactiva TODOS los
 * validadores de la propiedad (también `@IsNumber`): acá el chequeo de rango
 * tiene que convivir con la validación base, así que va todo en un único
 * validador a medida.
 */
export function EsRecargoValido(opciones?: ValidationOptions) {
  return function (objeto: object, propiedad: string) {
    registerDecorator({
      name: 'esRecargoValido',
      target: objeto.constructor,
      propertyName: propiedad,
      options: opciones,
      validator: {
        validate: (valor: unknown, args: ValidationArguments) => {
          if (typeof valor !== 'number' || Number.isNaN(valor)) return false;
          if (valor < 0) return false;
          if (tipoDe(args.object) === CoverageZoneSurchargeType.PERCENTAGE) {
            return valor <= 100;
          }
          return true;
        },
        defaultMessage: (args: ValidationArguments) =>
          tipoDe(args.object) === CoverageZoneSurchargeType.PERCENTAGE
            ? 'surchargeValue: un recargo porcentual tiene que estar entre 0 y 100'
            : 'surchargeValue: un recargo fijo no puede ser negativo',
      },
    });
  };
}
