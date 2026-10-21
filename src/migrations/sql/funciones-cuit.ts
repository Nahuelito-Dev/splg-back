/**
 * Funciones SQL del dígito verificador de CUIT/CUIL. Las crea la migración
 * `ChecksDeLaBase` y también el arranque de la base de las pruebas de
 * integración (que arma el esquema desde las entidades y necesita las funciones
 * antes de crear los CHECK que las usan).
 */
export const CREAR_ES_CUIT_VALIDO = `CREATE FUNCTION es_cuit_valido(cuit text) RETURNS boolean
         LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
         SELECT CASE
           WHEN cuit IS NULL OR cuit !~ '^(20|23|24|27|30|33|34)[0-9]{9}$' THEN false
           ELSE (
             SELECT CASE WHEN r = 0 THEN 0 ELSE 11 - r END
               FROM (
                 SELECT mod(sum(substr(cuit, i, 1)::int * (ARRAY[5,4,3,2,7,6,5,4,3,2])[i]), 11) AS r
                   FROM generate_series(1, 10) AS i
               ) AS s
           ) = substr(cuit, 11, 1)::int
         END
       $$`;

export const CREAR_ES_CUIL_VALIDO = `CREATE FUNCTION es_cuil_valido(cuil text) RETURNS boolean
         LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
         SELECT es_cuit_valido(cuil) AND left(cuil, 2) IN ('20', '23', '24', '27')
       $$`;
