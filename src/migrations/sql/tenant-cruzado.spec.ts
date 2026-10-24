import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import {
  CLAVE_DEL_PADRE,
  CLAVES_CRUZADAS,
  nombreDeLaClave,
  nombreDelUnicoDelPadre,
  PADRES,
  sqlDeClave,
  sqlDeUnicoDelPadre,
  sqlDeViolaciones,
} from './tenant-cruzado';

const RAIZ = join(__dirname, '..', '..');

function entidades(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const ruta = join(dir, f);
    if (statSync(ruta).isDirectory()) return entidades(ruta);
    return f.endsWith('.entity.ts') ? [ruta] : [];
  });
}

describe('Tenant cruzado: la base y las entidades dicen lo mismo', () => {
  beforeAll(() => {
    for (const ruta of entidades(RAIZ)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(ruta);
    }
  });

  const storage = () => getMetadataArgsStorage();
  const tablaDe = (target: unknown): string | undefined =>
    storage().tables.find((t) => t.target === target)?.name;

  it('cada clave cruzada tiene su @ForeignKey con el mismo nombre, columnas y padre', () => {
    const declaradas = storage()
      .foreignKeys.filter((f) => f.name?.endsWith('_distribuidora'))
      .map((f) => {
        const padre = (f.type as () => unknown)();
        return {
          nombre: f.name,
          hijo: tablaDe(f.target),
          columnas: f.columnNames,
          padre: tablaDe(padre),
          referenciadas: f.referencedColumnNames,
        };
      });
    const esperadas = CLAVES_CRUZADAS.map(([hijo, columna, padre]) => ({
      nombre: nombreDeLaClave(hijo, columna),
      hijo,
      columnas: [columna, 'distributor_id'],
      padre,
      referenciadas: [CLAVE_DEL_PADRE[padre], 'distributor_id'],
    }));
    const orden = (
      a: { nombre?: string | undefined },
      b: { nombre?: string | undefined },
    ) => (a.nombre ?? '').localeCompare(b.nombre ?? '');
    expect([...declaradas].sort(orden)).toEqual([...esperadas].sort(orden));
  });

  it('cada padre declara su único (id, distributor_id)', () => {
    const uniques = storage().uniques.map((u) => u.name);
    for (const padre of PADRES) {
      expect(uniques).toContain(nombreDelUnicoDelPadre(padre));
    }
  });

  it('el SQL de la migración usa las mismas claves', () => {
    const [hijo, columna, padre] = CLAVES_CRUZADAS[0];
    expect(sqlDeClave(hijo, columna, padre)).toContain(
      nombreDeLaClave(hijo, columna),
    );
    expect(sqlDeUnicoDelPadre(padre)).toContain('UNIQUE');
    expect(sqlDeViolaciones(hijo, columna, padre)).toContain(
      'p."distributor_id" <> c."distributor_id"',
    );
  });
});
