import { registerDecorator, ValidationOptions } from 'class-validator';
import { esCbuValido } from '../../common/utils/datos-bancarios';

/** CBU de 22 dígitos con los dos dígitos verificadores correctos. */
export function EsCbu(opciones?: ValidationOptions) {
  return function (objeto: object, propiedad: string) {
    registerDecorator({
      name: 'esCbu',
      target: objeto.constructor,
      propertyName: propiedad,
      options: opciones,
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' && esCbuValido(valor),
        defaultMessage: () =>
          'cbu tiene que ser un CBU de 22 dígitos con los dígitos verificadores correctos',
      },
    });
  };
}
