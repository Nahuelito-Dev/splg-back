import { nombreVisibleDeLaEmpresa } from './nombre-visible-de-la-empresa';

describe('nombreVisibleDeLaEmpresa: el nombre con que la conocen sus clientes', () => {
  it('el de marca del tema vigente si no está en blanco; si no, el legal', () => {
    const sql = nombreVisibleDeLaEmpresa('d').replace(/\s+/g, ' ');
    expect(sql).toBe(
      `COALESCE( (SELECT NULLIF(btrim(th."display_name"), '') FROM "distributor_theme" th WHERE th."distributor_id" = d."distributor_id" AND th."deleted_at" IS NULL), d."name")`,
    );
  });
});
