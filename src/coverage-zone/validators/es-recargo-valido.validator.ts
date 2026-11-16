import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { CoverageZoneSurchargeType } from '../entities/coverage-zone.entity';

/**
 * El `surchargeType` del mismo objeto, o undefined si no vino. Sin tipo no se
 * sabe el tope: en un alta vale el default de la columna y en una edición el
 * tipo que ya tiene la zona, y los dos casos los resuelve el servicio.
 */
function tipoDe(objeto: unknown): CoverageZoneSurchargeType | undefined {
  return (objeto as { surchargeType?: CoverageZoneSurchargeType })
    .surchargeType;
}

/**
 * Valida `surchargeValue` según el `surchargeType` del mismo objeto: un
 * recargo `percentage` tiene que estar entre 0 y 100; uno `fixed` sólo no
 * puede ser negativo. Si el tipo no vino en el body, sólo se exige que no sea
 * negativo y el tope lo controla el servicio contra el tipo real.
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
        defaultMessage: (args: ValidationArguments) => {
          const tipo = tipoDe(args.object);
          if (tipo === CoverageZoneSurchargeType.PERCENTAGE) {
            return 'surchargeValue: un recargo porcentual tiene que estar entre 0 y 100';
          }
          return tipo === CoverageZoneSurchargeType.FIXED
            ? 'surchargeValue: un recargo fijo no puede ser negativo'
            : 'surchargeValue: un recargo no puede ser negativo';
        },
      },
    });
  };
}
