/**
 * `UsersService.findAll` (la consulta de `GET /users`, contra Postgres real; el
 * endpoint por HTTP lo cubre la matriz T1) lista por fecha de alta, la más nueva primero, y con la misma
 * fecha desempata por id (como el listado de clientes). Sin un orden propio,
 * TypeORM elegía cada página por `user_id`: un UUID al azar, así que el orden no
 * significaba nada y una persona caía en una página u otra según su id.
 */
import { DataSource } from 'typeorm';
import { UsersService } from '../../src/users/users.service';
import { TestEnv, createTestApp, telefonoDePrueba } from './setup/test-env';

jest.setTimeout(180_000);

describe('UsersService.findAll: orden y paginación', () => {
  let env: TestEnv;
  let usuarios: UsersService;
  const CANTIDAD = 40;
  /** Fecha de alta de cada correo, para comparar con el orden devuelto. */
  const altas = new Map<string, number>();

  const recorrer = async (limite: number) => {
    const vistos: Array<{ userId: string; email: string }> = [];
    let total = 0;
    let offset = 0;
    do {
      const pagina = await usuarios.findAll({ limit: limite, offset });
      total = pagina.maxUsers;
      vistos.push(
        ...pagina.users.map((u) => ({
          userId: u.userId,
          email: u.email ?? '',
        })),
      );
      offset += limite;
    } while (offset < total);
    return { vistos, total };
  };

  beforeAll(async () => {
    env = await createTestApp();
    usuarios = env.app.get(UsersService);
    const ds = env.app.get(DataSource);
    // El contenedor arranca vacío: el rol se crea si no está.
    await ds.query(
      `INSERT INTO role (type) SELECT 'customer' WHERE NOT EXISTS (SELECT 1 FROM role WHERE type = 'customer')`,
    );
    const [{ role_id: rol }]: Array<{ role_id: string }> = await ds.query(
      `SELECT role_id FROM role WHERE type = 'customer'`,
    );
    // La mitad con fechas distintas; la otra mitad, todos en el mismo instante
    // (una importación o un seed): ahí decide el desempate.
    for (let i = 0; i < CANTIDAD; i++) {
      const alta =
        i < CANTIDAD / 2
          ? Date.UTC(2026, 0, 1) + i * 60_000
          : Date.UTC(2025, 0, 1);
      const email = `paginacion${i}@splg-test.com`;
      altas.set(email, alta);
      await ds.query(
        `INSERT INTO "user" (email, full_name, phone_number, firebase_uid, role_id, "createdAt")
         VALUES ($1, $2, $3, $1, $4, $5)`,
        [email, `Paginación ${i}`, telefonoDePrueba(), rol, new Date(alta)],
      );
    }
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('la más nueva primero y, con la misma fecha, por id', async () => {
    const { vistos } = await recorrer(10);
    const nuestros = vistos.filter((u) => altas.has(u.email));
    expect(nuestros).toHaveLength(CANTIDAD);
    // Lo esperado: fecha descendente y, a igual fecha, id ascendente (los UUID
    // en minúscula se comparan igual en JS que en Postgres).
    const esperado = [...nuestros].sort(
      (a, b) =>
        altas.get(b.email)! - altas.get(a.email)! ||
        (a.userId < b.userId ? -1 : 1),
    );
    expect(nuestros.map((u) => u.email)).toEqual(esperado.map((u) => u.email));
  });

  it.each([7, 10, 13])(
    'con páginas de %i no se repite ni falta nadie',
    async (limite) => {
      const { vistos, total } = await recorrer(limite);
      expect(vistos).toHaveLength(total);
      expect(new Set(vistos.map((u) => u.userId)).size).toBe(total);
    },
  );
});
