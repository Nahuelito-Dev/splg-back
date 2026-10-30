import { DataSource } from 'typeorm';
import { SesionAuditService } from './sesion-audit.service';

describe('SesionAuditService', () => {
  let query: jest.Mock;
  let service: SesionAuditService;
  const CUENTA = { user_id: 'u-1', distributor_id: 'd-1' };

  /** Primero busca la cuenta por email; después inserta el asiento. */
  const conCuenta = (cuenta: typeof CUENTA | null) =>
    query
      .mockResolvedValueOnce(cuenta ? [cuenta] : [])
      .mockResolvedValueOnce([]);

  beforeEach(() => {
    query = jest.fn();
    service = new SesionAuditService({ query } as unknown as DataSource);
  });

  const insercion = () => query.mock.calls[1] as [string, unknown[]];
  const detalles = () =>
    JSON.parse(String(insercion()[1][6])) as Array<{
      field: string;
      value: string;
    }>;

  it('un ingreso correcto es la acción Ingreso (6) a nombre de la cuenta y de su distribuidora', async () => {
    conCuenta(CUENTA);
    await service.registrarIngreso({
      ok: true,
      email: 'a@b.com',
      canal: 'panel',
      origen: 'dashboard',
      ip: '10.0.0.1',
    });
    const [sql, params] = insercion();
    expect(sql).toContain("'Sesion'");
    expect(params.slice(1, 6)).toEqual([6, 'u-1', 'd-1', 'u-1', '10.0.0.1']);
    expect(detalles()).toEqual([
      { field: 'email', value: 'a@b.com' },
      { field: 'canal', value: 'panel' },
      { field: 'origen', value: 'dashboard' },
    ]);
  });

  it('un ingreso fallido contra una cuenta existe sin usuario, con la cuenta en el detalle y su distribuidora', async () => {
    conCuenta(CUENTA);
    await service.registrarIngreso({
      ok: false,
      email: 'a@b.com',
      canal: 'app',
      origen: null,
      ip: null,
      motivo: 'credenciales incorrectas',
    });
    const [, params] = insercion();
    // acción, usuario (nulo), distribuidora de la cuenta, record_id = email
    expect(params.slice(1, 5)).toEqual([7, null, 'd-1', 'a@b.com']);
    expect(detalles()).toEqual([
      { field: 'email', value: 'a@b.com' },
      { field: 'canal', value: 'app' },
      { field: 'motivo', value: 'credenciales incorrectas' },
      { field: 'cuenta', value: 'u-1' },
    ]);
  });

  it('un ingreso fallido contra un email que no existe no lleva cuenta ni distribuidora', async () => {
    conCuenta(null);
    await service.registrarIngreso({
      ok: false,
      email: 'nadie@b.com',
      canal: 'app',
      origen: null,
      ip: null,
      motivo: 'credenciales incorrectas',
    });
    const [, params] = insercion();
    expect(params.slice(1, 5)).toEqual([7, null, null, 'nadie@b.com']);
    expect(detalles().map((d) => d.field)).toEqual([
      'email',
      'canal',
      'motivo',
    ]);
  });

  it('si la auditoría falla no rompe el ingreso', async () => {
    query.mockRejectedValue(new Error('base caída'));
    await expect(
      service.registrarIngreso({
        ok: true,
        email: 'a@b.com',
        canal: 'app',
        origen: null,
        ip: null,
      }),
    ).resolves.toBeUndefined();
  });
});
