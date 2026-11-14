import { SetMetadata } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import {
  CATALOGO_DE_MODULOS,
  type ModuloKey,
} from '../modules/catalogo-de-modulos';

export const REQUIERE_MODULO_KEY = 'requiereModulo';

type Respuestas = Record<string, { description?: string } | undefined>;

/** El texto del 403 por módulo, tal como queda en Swagger. */
export function textoDel403DeModulo(modulo: ModuloKey): string {
  return `La función «${CATALOGO_DE_MODULOS[modulo].label}» no está habilitada para la distribuidora (\`MODULE_DISABLED\`)`;
}

/** Suma el texto del 403 por módulo al 403 que ya documenta `objetivo` (o lo crea). */
function sumarAl403(objetivo: object, texto: string, crear: boolean): void {
  const respuestas = Reflect.getMetadata(DECORATORS.API_RESPONSE, objetivo) as
    | Respuestas
    | undefined;
  const previo = respuestas?.['403'];
  if (!previo && !crear) return;
  if (previo?.description?.includes(texto)) return;
  Reflect.defineMetadata(
    DECORATORS.API_RESPONSE,
    {
      ...respuestas,
      403: {
        ...previo,
        description: previo?.description
          ? `${previo.description}. ${texto}`
          : texto,
      },
    },
    objetivo,
  );
}

/**
 * Ata un endpoint (o un controller entero) a un módulo de la plataforma
 * (DISENO-PLATAFORMA-ORIXTECH §6.2). Si la empresa de la request no lo tiene
 * habilitado, `ModuloGuard` responde 403 `MODULE_DISABLED`. Es la única forma
 * de atar un endpoint a un módulo: el test de inventario
 * (`inventario-de-modulos.spec.ts`) fija qué ruta va con cuál.
 *
 * Swagger: suma `MODULE_DISABLED` al 403 que ya documentan `@Auth` y
 * `@Permiso` (no lo pisa). Por eso va ARRIBA de ellos, en la clase y en el
 * método: los decoradores se aplican de abajo hacia arriba. En la clase,
 * además, lo suma al 403 propio de cada método (el del método manda en el
 * documento). El inventario verifica que cada ruta atada lo documente.
 *
 * `@SinModulo()` en un método de un controller atado lo deja fuera (lo que está
 * en curso tiene que poder terminar, §7.3).
 */
export function RequiereModulo(
  modulo: ModuloKey,
): MethodDecorator & ClassDecorator {
  const texto = textoDel403DeModulo(modulo);
  const decorador = (
    objetivo: object,
    clave?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    if (descriptor) {
      SetMetadata(REQUIERE_MODULO_KEY, modulo)(objetivo, clave!, descriptor);
      // En un método sin 403 propio, el de la clase (`@Auth`) todavía no existe
      // (los de clase se aplican después) y el del método lo taparía: se nombra
      // también el rol.
      const propias = Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        descriptor.value as object,
      ) as Respuestas | undefined;
      sumarAl403(
        descriptor.value as object,
        propias?.['403']
          ? texto
          : `La cuenta no tiene el rol que pide el endpoint, o ${texto.charAt(0).toLowerCase()}${texto.slice(1)}`,
        true,
      );
      return;
    }
    SetMetadata(REQUIERE_MODULO_KEY, modulo)(objetivo as () => void);
    const deLaClase = (
      Reflect.getMetadata(DECORATORS.API_RESPONSE, objetivo) as
        | Respuestas
        | undefined
    )?.['403'];
    sumarAl403(objetivo, texto, true);
    const proto = (objetivo as { prototype: Record<string, unknown> })
      .prototype;
    for (const nombre of Object.getOwnPropertyNames(proto)) {
      const handler = proto[nombre];
      if (nombre === 'constructor' || typeof handler !== 'function') continue;
      if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
      // Un método fuera del módulo (`@SinModulo`) no lleva el 403 por módulo:
      // conserva el 403 de la clase como estaba (rol, permiso, soporte).
      if (Reflect.getMetadata(REQUIERE_MODULO_KEY, handler) === null) {
        const propias = Reflect.getMetadata(
          DECORATORS.API_RESPONSE,
          handler,
        ) as Respuestas | undefined;
        if (deLaClase && !propias?.['403']) {
          Reflect.defineMetadata(
            DECORATORS.API_RESPONSE,
            { ...propias, 403: deLaClase },
            handler,
          );
        }
        continue;
      }
      sumarAl403(handler, texto, false);
    }
  };
  return decorador as MethodDecorator & ClassDecorator;
}

/**
 * Un método que queda fuera del módulo de su controller: lo en curso termina
 * aunque el módulo se apague (§7.3). Va con su motivo, que lee el inventario.
 */
export const SinModulo = (motivo: string): MethodDecorator =>
  ((
    objetivo: object,
    clave: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    SetMetadata(REQUIERE_MODULO_KEY, null)(objetivo, clave, descriptor);
    SetMetadata('sinModuloMotivo', motivo)(objetivo, clave, descriptor);
    return descriptor;
  }) as MethodDecorator;

/**
 * Para un endpoint que decide el módulo en el servicio (el proceso llega en la
 * ruta, como `/module-config/:process`): suma `MODULE_DISABLED` a su 403 de
 * Swagger sin atarlo. Va arriba de `@Permiso` y `@Auth`.
 */
export const Documenta403DeModuloDinamico = (): MethodDecorator =>
  ((
    _objetivo: object,
    _clave: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    sumarAl403(
      descriptor.value as object,
      'El proceso es de un módulo que la plataforma no le habilitó a la distribuidora (`MODULE_DISABLED`)',
      true,
    );
    return descriptor;
  }) as MethodDecorator;
