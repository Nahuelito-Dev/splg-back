import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { Auth } from '../../common/decorators/auth.decorator';
import { RoleType } from '../../common/constants/role-type.enum';
import type { AccesoDeLaEmpresa } from './acceso-de-la-empresa.service';
import { MENSAJE_MODULO_DESHABILITADO } from './errores';
import { ModuloGuard } from './modulo.guard';
import {
  RequiereModulo,
  SinModulo,
  textoDel403DeModulo,
} from './requiere-modulo.decorator';

@RequiereModulo('repurchase')
@Auth(RoleType.ADMIN, RoleType.SUPER_ADMIN)
@Controller('prueba')
class AtadoController {
  @Get('a')
  atado(): string {
    return 'a';
  }

  @SinModulo('Lo en curso termina')
  @Get('b')
  fuera(): string {
    return 'b';
  }

  @RequiereModulo('express')
  @ApiForbiddenResponse({ description: 'Sin el permiso de pedidos' })
  @Get('c')
  otroModulo(): string {
    return 'c';
  }

  @ApiForbiddenResponse({ description: 'Propio del método' })
  @Get('d')
  conSu403(): string {
    return 'd';
  }
}

@Controller('libre')
class LibreController {
  @Get()
  libre(): string {
    return 'x';
  }
}

function contexto(
  clase: new () => object,
  metodo: string,
  distributorId: string | null | undefined,
  tipo = 'http',
): ExecutionContext {
  const handler = (clase.prototype as Record<string, () => unknown>)[metodo];
  return {
    getType: () => tipo,
    getHandler: () => handler,
    getClass: () => clase,
    switchToHttp: () => ({ getRequest: () => ({ distributorId }) }),
  } as unknown as ExecutionContext;
}

const metodo = (nombre: string): object =>
  (AtadoController.prototype as unknown as Record<string, object>)[nombre];

const respuestas = (objetivo: object) =>
  Reflect.getMetadata(DECORATORS.API_RESPONSE, objetivo) as Record<
    string,
    { description: string } | undefined
  >;

describe('ModuloGuard y @RequiereModulo (§6.2)', () => {
  let habilitado: jest.Mock;
  let guard: ModuloGuard;

  beforeEach(() => {
    habilitado = jest.fn((id: string) => Promise.resolve(id === 'B'));
    guard = new ModuloGuard(new Reflector(), {
      habilitado,
    } as unknown as AccesoDeLaEmpresa);
  });

  it('sin el módulo habilitado responde 403 MODULE_DISABLED en castellano', async () => {
    await expect(
      guard.canActivate(contexto(AtadoController, 'atado', 'A')),
    ).rejects.toMatchObject({
      status: 403,
      response: {
        code: 'MODULE_DISABLED',
        message: MENSAJE_MODULO_DESHABILITADO,
      },
    });
    expect(habilitado).toHaveBeenCalledWith('A', 'repurchase');
  });

  it('el mensaje no le habla a la distribuidora de planes ni de módulos', () => {
    expect(MENSAJE_MODULO_DESHABILITADO).not.toMatch(
      /plan|m[óo]dulo|habilitad/i,
    );
  });

  it('otra empresa con el módulo habilitado pasa', async () => {
    await expect(
      guard.canActivate(contexto(AtadoController, 'atado', 'B')),
    ).resolves.toBe(true);
  });

  it('el módulo del método manda sobre el de la clase', async () => {
    await expect(
      guard.canActivate(contexto(AtadoController, 'otroModulo', 'A')),
    ).rejects.toMatchObject({ status: 403 });
    expect(habilitado).toHaveBeenCalledWith('A', 'express');
  });

  it('@SinModulo deja pasar aunque el controller esté atado', async () => {
    await expect(
      guard.canActivate(contexto(AtadoController, 'fuera', 'A')),
    ).resolves.toBe(true);
    expect(habilitado).not.toHaveBeenCalled();
  });

  it('un endpoint sin módulo no consulta nada', async () => {
    await expect(
      guard.canActivate(contexto(LibreController, 'libre', 'A')),
    ).resolves.toBe(true);
    expect(habilitado).not.toHaveBeenCalled();
  });

  it('sin tenant no decide (lo resuelve el endpoint)', async () => {
    await expect(
      guard.canActivate(contexto(AtadoController, 'atado', null)),
    ).resolves.toBe(true);
    expect(habilitado).not.toHaveBeenCalled();
  });

  it('en GraphQL aplica igual, con la empresa de la request del contexto', async () => {
    const ctx = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, { req: { distributorId: 'A' } }, {}],
      getHandler: () =>
        (AtadoController.prototype as unknown as Record<string, object>)[
          'atado'
        ],
      getClass: () => AtadoController,
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      status: 403,
    });
    expect(habilitado).toHaveBeenCalledWith('A', 'repurchase');
  });

  it('fuera de HTTP no aplica', async () => {
    await expect(
      guard.canActivate(contexto(AtadoController, 'atado', 'A', 'ws')),
    ).resolves.toBe(true);
  });

  describe('Swagger', () => {
    it('suma MODULE_DISABLED al 403 de @Auth sin pisarlo', () => {
      const r = respuestas(AtadoController);
      expect(r['403']?.description).toMatch(
        /^Requiere rol: admin, super_admin/,
      );
      expect(r['403']?.description).toContain(
        textoDel403DeModulo('repurchase'),
      );
    });

    it('en un método con 403 propio lo suma a ese 403', () => {
      const r = respuestas(metodo('conSu403'));
      expect(r['403']?.description).toBe(
        `Propio del método. ${textoDel403DeModulo('repurchase')}`,
      );
    });

    it('a nivel método suma el de su módulo al de su @ApiForbiddenResponse', () => {
      const r = respuestas(metodo('otroModulo'));
      expect(r['403']?.description).toContain('Sin el permiso de pedidos');
      expect(r['403']?.description).toContain(textoDel403DeModulo('express'));
    });

    it('un método @SinModulo conserva el 403 de la clase sin MODULE_DISABLED', () => {
      const r = respuestas(metodo('fuera'));
      expect(r['403']?.description).toMatch(/^Requiere rol/);
      expect(r['403']?.description).not.toContain('MODULE_DISABLED');
    });

    it('aplicarlo dos veces no repite el texto', () => {
      RequiereModulo('repurchase')(AtadoController);
      const r = respuestas(AtadoController);
      expect(
        r['403']?.description.split(textoDel403DeModulo('repurchase')).length,
      ).toBe(2);
    });
  });
});
