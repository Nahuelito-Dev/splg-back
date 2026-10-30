/**
 * Genera el mapa que usa el trigger de auditoría (tabla→entidad, columna→propiedad)
 * a partir de la metadata de TypeORM. No toca la base.
 *
 *   npm run auditoria:mapa                       # reescribe src/audit/data/auditoria-mapa.datos.json
 *   npm run auditoria:mapa -- --migracion Nombre # además crea la migración que lo aplica
 *
 * Cuando se agrega una entidad o una columna: correr el segundo comando, revisar
 * la migración y `npm run migration:run`. El test `auditoria-mapa.spec.ts` falla
 * si el JSON no coincide con las entidades.
 */
import 'reflect-metadata';
import { existsSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { construirMapa } from '../src/audit/data/auditoria-mapa';

const RAIZ = join(__dirname, '..');
const RUTA_JSON = join(RAIZ, 'src/audit/data/auditoria-mapa.datos.json');

async function main(): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    entities: [join(RAIZ, 'src/**/*.entity.ts')],
  });
  await (
    dataSource as unknown as { buildMetadatas(): Promise<void> }
  ).buildMetadatas();
  const mapa = construirMapa(dataSource.entityMetadatas);
  const json = JSON.stringify(mapa, null, 2) + '\n';
  writeFileSync(RUTA_JSON, json);
  console.log(
    `mapa: ${mapa.entities.length} tablas, ${mapa.fields.length} campos -> ${RUTA_JSON}`,
  );

  const i = process.argv.indexOf('--migracion');
  if (i === -1) return;
  const nombre = process.argv[i + 1];
  if (!nombre || !/^[A-Z][A-Za-z0-9]+$/.test(nombre)) {
    throw new Error('--migracion necesita un nombre en PascalCase');
  }
  const dir = join(RAIZ, 'src/migrations');
  const ultimo = readdirSync(dir)
    .map((f) => Number(f.split('-')[0]))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  const ts = Math.max(Date.now(), ultimo + 1);
  const archivo = join(dir, `${ts}-${nombre}.ts`);
  if (existsSync(archivo)) throw new Error(`${archivo} ya existe`);
  writeFileSync(
    archivo,
    `import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aplica el mapa de auditoría vigente (generado con \`npm run auditoria:mapa\`):
 * actualiza \`audit_entity_map\` y \`audit_field_map\` e instala el trigger en
 * las tablas nuevas. No quita nada: una tabla que deja de auditarse se
 * desinstala a mano con \`auditoria_desinstalar\`.
 */
export const MAPA = ${JSON.stringify(mapa)};

export class ${nombre}${ts} implements MigrationInterface {
  name = '${nombre}${ts}';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SELECT auditoria_aplicar_mapa($1::jsonb)', [
      JSON.stringify(MAPA),
    ]);
  }

  public async down(): Promise<void> {
    // El mapa anterior queda en la migración anterior: revertir esta no desinstala triggers.
  }
}
`,
  );
  console.log(`migración: ${archivo}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
