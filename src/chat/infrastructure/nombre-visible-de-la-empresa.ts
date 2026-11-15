/**
 * El nombre con que el cliente conoce a la empresa: el de su marca
 * (`distributor_theme.display_name`, ej. «Florchi Gas») si lo cargó y el tema
 * está vigente; si no, el nombre legal (`distributor.name`). Es el que usan el
 * asistente (su firma) y la variable `{{empresa.nombre}}` de las respuestas.
 *
 * Expresión SQL sobre una fila de `distributor` con el alias dado.
 */
export function nombreVisibleDeLaEmpresa(alias: string): string {
  return `COALESCE(
    (SELECT NULLIF(btrim(th."display_name"), '')
       FROM "distributor_theme" th
      WHERE th."distributor_id" = ${alias}."distributor_id"
        AND th."deleted_at" IS NULL),
    ${alias}."name")`;
}
