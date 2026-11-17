import type { DataSource } from 'typeorm';
import { SIN_USO } from '../assistant-ai/asistente-ia.dominio';
import {
  type AsistenteIaService,
  type PruebaDelAsistente,
  TopeDePruebasAlcanzado,
} from '../assistant-ai/asistente-ia.service';
import { Customer } from '../customer/entities/customer.entity';
import { ProbadorService } from './probador.service';

const EMPRESA = '11111111-1111-4111-8111-111111111111';
const CLIENTE = '55555555-5555-4555-8555-555555555555';

function armar(cliente: { userId: string } | null = { userId: 'user-cli' }) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve(cliente)),
  };
  const repo = { createQueryBuilder: jest.fn(() => qb) };
  const dataSource = { getRepository: jest.fn(() => repo) };
  const probar = jest.fn<Promise<unknown>, [PruebaDelAsistente]>(() =>
    Promise.resolve({
      resultado: {
        tipo: 'respuesta' as const,
        texto: 'Sí.',
        modelo: 'claude-haiku-5-5',
        uso: SIN_USO,
        herramientas: [],
      },
      fuentes: [],
      prendido: true,
    }),
  );
  const servicio = new ProbadorService(
    dataSource as unknown as DataSource,
    { probar } as unknown as AsistenteIaService,
  );
  return { servicio, probar, qb, dataSource };
}

describe('ProbadorService', () => {
  it('empresa sin cliente: prueba como un cliente anónimo de SU base y devuelve la vista previa', async () => {
    const t = armar();
    const r = await t.servicio.deLaEmpresa({
      distributorId: EMPRESA,
      question: '¿Abren?',
      actorUserId: 'admin-1',
    });
    expect(t.probar).toHaveBeenCalledWith({
      canal: 'clientes',
      distributorId: EMPRESA,
      customerUserId: null,
      pregunta: '¿Abren?',
      tipo: 'preview',
      actorUserId: 'admin-1',
    });
    expect(t.dataSource.getRepository).not.toHaveBeenCalled();
    expect(r).toMatchObject({ answer: 'Sí.', layer: 'ai' });
  });

  it('con un cliente de la empresa: pregunta como ese usuario (sus pedidos), con la regla de pertenencia de la API', async () => {
    const t = armar();
    await t.servicio.deLaEmpresa({
      distributorId: EMPRESA,
      question: '¿Y mi pedido?',
      customerId: CLIENTE,
      actorUserId: 'admin-1',
      tipo: 'regression',
    });
    expect(t.dataSource.getRepository).toHaveBeenCalledWith(Customer);
    expect(t.qb.where).toHaveBeenCalledWith(
      'customer.customerId = :customerId',
      { customerId: CLIENTE },
    );
    const [condicion, params] = t.qb.andWhere.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(condicion).toContain('customer_distributor');
    expect(condicion).toContain('removed_at IS NOT NULL');
    expect(params).toEqual({ distributorId: EMPRESA });
    expect(t.probar).toHaveBeenCalledWith(
      expect.objectContaining({
        customerUserId: 'user-cli',
        tipo: 'regression',
      }),
    );
  });

  it('un cliente que no es de la empresa (u otra empresa): 404 sin probar', async () => {
    const t = armar(null);
    await expect(
      t.servicio.deLaEmpresa({
        distributorId: EMPRESA,
        question: '¿Y mi pedido?',
        customerId: CLIENTE,
        actorUserId: 'admin-1',
      }),
    ).rejects.toMatchObject({
      response: { code: 'ASSISTANT_PREVIEW_CUSTOMER_NOT_FOUND' },
      status: 404,
    });
    expect(t.probar).not.toHaveBeenCalled();
  });

  it('plataforma: el soporte (C1), sin empresa ni cliente', async () => {
    const t = armar();
    await t.servicio.deLaPlataforma('¿Cómo cargo un chofer?', 'super-1');
    expect(t.probar).toHaveBeenCalledWith({
      canal: 'soporte',
      distributorId: null,
      customerUserId: null,
      pregunta: '¿Cómo cargo un chofer?',
      tipo: 'preview',
      actorUserId: 'super-1',
    });
  });

  it('cupo de pruebas agotado: 429 ASSISTANT_TEST_QUOTA_REACHED (empresa y plataforma); otro error sale tal cual', async () => {
    const t = armar();
    t.probar.mockRejectedValue(new TopeDePruebasAlcanzado(10_000));
    await expect(
      t.servicio.deLaEmpresa({
        distributorId: EMPRESA,
        question: '¿Abren?',
        actorUserId: 'a',
      }),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'ASSISTANT_TEST_QUOTA_REACHED' },
    });
    await expect(t.servicio.deLaPlataforma('¿Y?', 's')).rejects.toMatchObject({
      status: 429,
    });
    t.probar.mockRejectedValueOnce(new Error('otra cosa'));
    await expect(t.servicio.deLaPlataforma('¿Y?', 's')).rejects.toThrow(
      'otra cosa',
    );
  });
});
