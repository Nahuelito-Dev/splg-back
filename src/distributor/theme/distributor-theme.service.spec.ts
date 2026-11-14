import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { DistributorService } from '../distributor.service';
import type { DistributorLogoService } from '../distributor-logo.service';
import type { DistributorTheme } from '../entities/distributor-theme.entity';
import type { Distributor } from '../entities/distributor.entity';
import { generarTema, PRINCIPAL_POR_OMISION } from './generador-de-tema';
import {
  contrasteInsuficiente,
  DistributorThemeService,
} from './distributor-theme.service';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';

function armar(opciones: {
  activa?: Partial<DistributorTheme> | null;
  borrada?: Partial<DistributorTheme> | null;
}) {
  const distribuidora = {
    distributorId: A,
    name: 'Nahuel Gas',
    logoKey: 'distributors/a/logo/x.png',
  } as Distributor;
  const temas = {
    findOne: jest.fn((opts: { withDeleted?: boolean }) =>
      Promise.resolve(
        opts.withDeleted
          ? (opciones.borrada ?? null)
          : (opciones.activa ?? null),
      ),
    ),
    query: jest.fn().mockResolvedValue([]),
  };
  const distribuidoras = {
    findOne: jest.fn((id: string) =>
      id === A
        ? Promise.resolve(distribuidora)
        : Promise.reject(new NotFoundException('Distribuidora no encontrada')),
    ),
  };
  const logo = {
    firmar: jest.fn((d: Distributor) => {
      d.photoSignedUrl = 'https://firmada/logo';
      return Promise.resolve();
    }),
  };
  const servicio = new DistributorThemeService(
    temas as unknown as Repository<DistributorTheme>,
    distribuidoras as unknown as DistributorService,
    logo as unknown as DistributorLogoService,
  );
  return { servicio, temas, distribuidoras };
}

describe('DistributorThemeService', () => {
  describe('vigente', () => {
    it('sin tema propio: el por omisión con el nombre real y el logo firmado, versión 0', async () => {
      const { servicio } = armar({});
      const tema = await servicio.vigente(A);
      expect(tema).toMatchObject({
        isDefault: true,
        primaryColor: PRINCIPAL_POR_OMISION,
        accentColor: null,
        displayName: null,
        companyName: 'Nahuel Gas',
        logoUrl: 'https://firmada/logo',
        version: 0,
        updatedAt: null,
      });
      expect(tema.tokens).toEqual(generarTema(PRINCIPAL_POR_OMISION).tokens);
    });

    it('restablecido: el por omisión, pero conserva la versión que siguió subiendo', async () => {
      const { servicio } = armar({
        borrada: { version: 4, updatedAt: new Date('2026-11-14T10:00:00Z') },
      });
      await expect(servicio.vigente(A)).resolves.toMatchObject({
        isDefault: true,
        version: 4,
        updatedAt: '2026-11-14T10:00:00.000Z',
      });
    });

    it('con tema propio: lo guardado', async () => {
      const t = generarTema('#1D4ED8');
      const { servicio } = armar({
        activa: {
          primaryColor: '#1D4ED8',
          accentColor: null,
          displayName: 'Nahuel Gas Express',
          tokens: t.tokens,
          contrast: t.contrast,
          version: 2,
          updatedAt: new Date('2026-11-14T12:00:00Z'),
        },
      });
      await expect(servicio.vigente(A)).resolves.toMatchObject({
        isDefault: false,
        primaryColor: '#1D4ED8',
        displayName: 'Nahuel Gas Express',
        companyName: 'Nahuel Gas',
        version: 2,
        tokens: t.tokens,
      });
    });

    it('otra distribuidora (o dada de baja) → 404', async () => {
      const { servicio } = armar({});
      await expect(servicio.vigente('otra')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('guardar', () => {
    it('inserta o actualiza sólo la fila de la distribuidora del contexto, con tokens y contraste, y sube la versión', async () => {
      const { servicio, temas } = armar({});
      await servicio.guardar(
        A,
        {
          primaryColor: '#1D4ED8',
          accentColor: null,
          displayName: 'Nahuel Gas',
        },
        'u1',
      );
      expect(temas.query).toHaveBeenCalledTimes(1);
      const [sql, params] = temas.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ON CONFLICT ("distributor_id")');
      expect(sql).toContain('"version" = "distributor_theme"."version" + 1');
      expect(sql).toContain('"deleted_at" = NULL');
      expect(params[0]).toBe(A);
      expect(params.slice(1, 4)).toEqual(['#1D4ED8', null, 'Nahuel Gas']);
      expect(JSON.parse(params[4] as string)).toEqual(
        generarTema('#1D4ED8').tokens,
      );
      expect(params[6]).toBe('u1');
    });

    it('un color sin contraste → 400 THEME_CONTRAST_INSUFFICIENT con par y sugerencia, sin escribir', async () => {
      const { servicio, temas } = armar({});
      const error = await servicio
        .guardar(A, { primaryColor: '#FEC84B' }, 'u1')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      const cuerpo = (error as BadRequestException).getResponse();
      expect(cuerpo).toMatchObject({
        statusCode: 400,
        code: 'THEME_CONTRAST_INSUFFICIENT',
        field: 'primaryColor',
        pair: 'primary/surface',
        ratio: 1.54,
        required: 3,
      });
      expect((cuerpo as { message: string }).message).toMatch(
        /^El color principal no contrasta lo suficiente con el blanco \(1,54:1; hace falta 3:1\)\. Probá con #[0-9A-F]{6}$/,
      );
      expect(temas.query).not.toHaveBeenCalled();
    });

    it('otra distribuidora → 404 sin escribir', async () => {
      const { servicio, temas } = armar({});
      await expect(
        servicio.guardar('otra', { primaryColor: '#1D4ED8' }, 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(temas.query).not.toHaveBeenCalled();
    });
  });

  describe('vistaPrevia', () => {
    it('calcula sin escribir', async () => {
      const { servicio, temas } = armar({});
      const tema = await servicio.vistaPrevia(A, {
        primaryColor: '#0E7C3A',
        displayName: 'Verde Gas',
      });
      expect(tema).toMatchObject({
        primaryColor: '#0E7C3A',
        displayName: 'Verde Gas',
        companyName: 'Nahuel Gas',
        isDefault: false,
        version: 0,
      });
      expect(temas.query).not.toHaveBeenCalled();
    });

    it('el mismo 400 de contraste que el PUT', async () => {
      const { servicio } = armar({});
      await expect(
        servicio.vistaPrevia(A, {
          primaryColor: '#1D4ED8',
          accentColor: '#FFB020',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('restablecer', () => {
    it('baja lógica de la fila activa de esa distribuidora, subiendo la versión', async () => {
      const { servicio, temas } = armar({});
      await servicio.restablecer(A, 'u1');
      const [sql, params] = temas.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/^UPDATE "distributor_theme"/);
      expect(sql).toContain('"deleted_at" = now()');
      expect(sql).toContain('"version" = "version" + 1');
      expect(sql).toContain('"deleted_at" IS NULL');
      expect(sql).not.toMatch(/DELETE/);
      expect(params).toEqual([A, 'u1']);
    });

    it('otra distribuidora → 404', async () => {
      const { servicio } = armar({});
      await expect(servicio.restablecer('otra', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('contrasteInsuficiente nombra el acento cuando falla el acento', () => {
    const r = contrasteInsuficiente({
      field: 'accentColor',
      pair: 'accent/canvas',
      ratio: 1.69,
      required: 3,
      suggestion: '#C08200',
    }).getResponse() as { message: string };
    expect(r.message).toBe(
      'El color de acento no contrasta lo suficiente con el fondo del panel (1,69:1; hace falta 3:1). Probá con #C08200',
    );
  });
});
