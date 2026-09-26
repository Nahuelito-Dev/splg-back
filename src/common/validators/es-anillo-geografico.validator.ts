import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const LNG_MIN = -180;
const LNG_MAX = 180;
const LAT_MIN = -90;
const LAT_MAX = 90;

/** Describe por qué un anillo no sirve, para poder decirlo en el mensaje. */
function motivoDelRechazo(valor: unknown): string | null {
  if (!Array.isArray(valor)) return 'tiene que ser una lista de puntos';
  if (valor.length < 3) return 'necesita al menos tres vértices';

  for (const [i, punto] of valor.entries()) {
    if (!Array.isArray(punto) || punto.length !== 2) {
      return `el punto ${i + 1} tiene que ser [longitud, latitud]`;
    }
    const [lng, lat] = punto as unknown[];
    if (
      typeof lng !== 'number' ||
      typeof lat !== 'number' ||
      Number.isNaN(lng) ||
      Number.isNaN(lat)
    ) {
      return `el punto ${i + 1} tiene valores que no son números`;
    }
    if (lng < LNG_MIN || lng > LNG_MAX) {
      return `la longitud del punto ${i + 1} (${lng}) está fuera de ${LNG_MIN}..${LNG_MAX}`;
    }
    if (lat < LAT_MIN || lat > LAT_MAX) {
      return `la latitud del punto ${i + 1} (${lat}) está fuera de ${LAT_MIN}..${LAT_MAX}`;
    }
    // El error más común es mandar [lat, lng] en vez de [lng, lat]. Cuando la
    // primera componente no puede ser una longitud de por acá pero sí una
    // latitud, casi seguro están invertidos.
    if (Math.abs(lng) <= LAT_MAX && Math.abs(lat) > LAT_MAX) {
      return `el punto ${i + 1} parece tener las coordenadas invertidas: el orden es [longitud, latitud]`;
    }
  }
  return null;
}

/**
 * Valida que el valor sea un anillo de polígono geográfico usable.
 *
 * Antes el polígono se declaraba sólo con `@IsArray()` y `@ArrayMinSize(3)`:
 * el contenido no se miraba. Mandando los puntos como `[lat, lng]` en vez de
 * `[lng, lat]` —que es el error más fácil de cometer— el endpoint respondía
 * 201 y guardaba una zona cuyo centro caía en medio del Atlántico. No fallaba
 * nunca: simplemente la zona no cubría nada, y eso recién se notaba cuando un
 * pedido se rechazaba por estar "fuera de la zona de cobertura".
 */
export function EsAnilloGeografico(opciones?: ValidationOptions) {
  return function (objeto: object, propiedad: string) {
    registerDecorator({
      name: 'esAnilloGeografico',
      target: objeto.constructor,
      propertyName: propiedad,
      options: opciones,
      validator: {
        validate: (valor: unknown) => motivoDelRechazo(valor) === null,
        defaultMessage: (args: ValidationArguments) =>
          `${args.property}: ${motivoDelRechazo(args.value) ?? 'anillo inválido'}`,
      },
    });
  };
}
