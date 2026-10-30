/**
 * Auditoría de datos hecha por la base (F25). Un trigger `AFTER INSERT OR UPDATE
 * OR DELETE` por fila en cada tabla de negocio escribe en `audit` y
 * `audit_detail` (el modelo de la cátedra), sea quien sea que toque la tabla: la
 * API, un script o SQL a mano. Lo comparten la migración y las pruebas de
 * integración (el esquema sincronizado desde las entidades no trae triggers).
 *
 * El actor llega por variables de la transacción (`set_config(..., true)`):
 *  - `splg.user_id`, `splg.ip`, `splg.distributor_id`.
 * Sin ellas el asiento queda con usuario nulo («sistema»), con `db_user` y
 * `app_name` para saber quién fue.
 *
 * Qué tablas y qué nombres de entidad y de campo: `audit_entity_map` y
 * `audit_field_map`, que se generan desde la metadata de TypeORM
 * (`npm run auditoria:mapa`) y se cargan con `auditoria_aplicar_mapa`.
 */

/**
 * Rol de mantenimiento de la auditoría: sus miembros (y los superusuarios) pueden
 * apagarla en su sesión con `splg.audit_off = on`. NOLOGIN y a nivel de clúster:
 * se crea si no existe y nunca se borra (puede tener miembros).
 */
export const CREAR_ROL_DE_MANTENIMIENTO = `DO $$ BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'splg_mantenimiento') THEN
     CREATE ROLE splg_mantenimiento NOLOGIN;
   END IF;
 END $$`;

export const CREAR_TABLAS_DEL_MAPA = [
  `CREATE TABLE IF NOT EXISTS "audit_entity_map" (
     "table_name" varchar(63) PRIMARY KEY,
     "entity" varchar(60) NOT NULL,
     "pk_columns" text[] NOT NULL,
     "delete_column" text,
     "distributor_mode" text NOT NULL
       CHECK ("distributor_mode" IN ('self', 'column', 'parent', 'request', 'none')),
     "distributor_column" text,
     "parent_table" text,
     "parent_fk_column" text,
     "parent_pk_column" text,
     "parent_distributor_column" text,
     "order_property" text,
     "order_column" text
   )`,
  `CREATE TABLE IF NOT EXISTS "audit_field_map" (
     "table_name" varchar(63) NOT NULL
       REFERENCES "audit_entity_map" ("table_name") ON DELETE CASCADE,
     "column_name" text NOT NULL,
     "property" varchar(80) NOT NULL,
     "secret" boolean NOT NULL DEFAULT false,
     "kind" text NOT NULL CHECK ("kind" IN ('text', 'timestamp', 'json', 'geo')),
     "position" integer NOT NULL,
     PRIMARY KEY ("table_name", "column_name")
   )`,
];

export const CREAR_FUNCIONES_DE_AUDITORIA = [
  `CREATE OR REPLACE FUNCTION auditoria_uuid(p text) RETURNS uuid
   LANGUAGE sql IMMUTABLE AS $$
     SELECT CASE WHEN p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN p::uuid END
   $$`,

  // El valor como lo guardaba la aplicación: fechas ISO en UTC, booleanos
  // true/false, números tal cual, jsonb y puntos como JSON.
  `CREATE OR REPLACE FUNCTION auditoria_texto(p_kind text, p_valor jsonb) RETURNS text
   LANGUAGE plpgsql STABLE AS $$
   BEGIN
     IF p_valor IS NULL OR p_valor = 'null'::jsonb THEN RETURN NULL; END IF;
     IF p_kind = 'timestamp' THEN
       RETURN to_char((p_valor #>> '{}')::timestamptz AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
     ELSIF p_kind = 'geo' THEN
       RETURN ST_AsGeoJSON((p_valor #>> '{}')::geometry);
     ELSIF p_kind = 'json' THEN
       RETURN p_valor::text;
     END IF;
     IF jsonb_typeof(p_valor) = 'string' THEN RETURN p_valor #>> '{}'; END IF;
     RETURN p_valor::text;
   END
   $$`,

  `CREATE OR REPLACE FUNCTION auditoria_trigger() RETURNS trigger
   LANGUAGE plpgsql AS $$
   DECLARE
     v_ent audit_entity_map%ROWTYPE;
     v_old jsonb;
     v_new jsonb;
     v_row jsonb;
     v_accion smallint;
     v_audit uuid;
     v_campos text[] := '{}';
     v_viejos text[] := '{}';
     v_nuevos text[] := '{}';
     f record;
     v_ov jsonb;
     v_nv jsonb;
     v_o text;
     v_n text;
     v_dist uuid;
     v_dist_txt text;
     v_user uuid;
     v_record text;
     v_pedido text;
   BEGIN
     -- Mantenimiento (seeds de desarrollo): una sesión que fija
     -- splg.audit_off = 'on' no deja asientos, pero SÓLO si su usuario es
     -- miembro del rol splg_mantenimiento (un superusuario lo es). Para
     -- cualquier otra sesión el valor se ignora y se audita igual.
     IF current_setting('splg.audit_off', true) = 'on' THEN
       IF pg_has_role(session_user, 'splg_mantenimiento', 'MEMBER') THEN
         RETURN NULL;
       END IF;
     END IF;
     SELECT * INTO v_ent FROM audit_entity_map WHERE table_name = TG_TABLE_NAME;
     IF NOT FOUND THEN RETURN NULL; END IF;
     IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
     IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
     IF TG_OP = 'UPDATE' AND v_old = v_new THEN RETURN NULL; END IF;
     v_accion := CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'UPDATE' THEN 2 ELSE 5 END;

     FOR f IN
       SELECT column_name, property, secret, kind
         FROM audit_field_map WHERE table_name = TG_TABLE_NAME ORDER BY position
     LOOP
       v_ov := v_old -> f.column_name;
       v_nv := v_new -> f.column_name;
       IF v_ov = 'null'::jsonb THEN v_ov := NULL; END IF;
       IF v_nv = 'null'::jsonb THEN v_nv := NULL; END IF;
       IF v_ov IS NOT DISTINCT FROM v_nv THEN CONTINUE; END IF;
       v_o := auditoria_texto(f.kind, v_ov);
       v_n := auditoria_texto(f.kind, v_nv);
       IF v_o IS NOT DISTINCT FROM v_n THEN CONTINUE; END IF;
       IF f.secret THEN
         IF v_o IS NOT NULL THEN v_o := '[oculto]'; END IF;
         IF v_n IS NOT NULL THEN v_n := '[oculto]'; END IF;
       ELSE
         IF length(v_o) > 2000 THEN v_o := left(v_o, 2000) || '…'; END IF;
         IF length(v_n) > 2000 THEN v_n := left(v_n, 2000) || '…'; END IF;
       END IF;
       IF TG_OP = 'UPDATE' AND f.column_name = v_ent.delete_column THEN
         v_accion := CASE WHEN v_nv IS NULL THEN 4 ELSE 3 END;
       END IF;
       v_campos := array_append(v_campos, f.property::text);
       v_viejos := array_append(v_viejos, v_o);
       v_nuevos := array_append(v_nuevos, v_n);
     END LOOP;

     -- Un UPDATE que sólo tocó columnas que no se auditan no deja asiento.
     IF TG_OP = 'UPDATE' AND cardinality(v_campos) = 0 THEN RETURN NULL; END IF;

     v_row := COALESCE(v_old, v_new);

     -- Renglones y pagos de un pedido: el id del pedido va siempre, para
     -- encontrarlos en el historial del pedido.
     IF v_ent.order_property IS NOT NULL
        AND NOT (v_ent.order_property = ANY (v_campos)) THEN
       v_pedido := v_row ->> v_ent.order_column;
       IF v_pedido IS NOT NULL THEN
         v_campos := array_append(v_campos, v_ent.order_property);
         v_viejos := array_append(v_viejos, v_pedido);
         v_nuevos := array_append(v_nuevos, v_pedido);
       END IF;
     END IF;

     SELECT left(string_agg(COALESCE(v_row ->> c.col, ''), ':' ORDER BY c.i), 64)
       INTO v_record
       FROM unnest(v_ent.pk_columns) WITH ORDINALITY AS c(col, i);

     v_dist := CASE v_ent.distributor_mode
       WHEN 'self' THEN auditoria_uuid(v_row ->> v_ent.pk_columns[1])
       WHEN 'column' THEN auditoria_uuid(v_row ->> v_ent.distributor_column)
       WHEN 'request' THEN auditoria_uuid(current_setting('splg.distributor_id', true))
       ELSE NULL
     END;
     -- Renglón sin distribuidora propia: la del padre por su FK; si el padre ya
     -- no está (borrado en cascada), la del request.
     IF v_ent.distributor_mode = 'parent' THEN
       EXECUTE format('SELECT %I::text FROM %I WHERE %I = $1::uuid',
                      v_ent.parent_distributor_column, v_ent.parent_table, v_ent.parent_pk_column)
         INTO v_dist_txt USING v_row ->> v_ent.parent_fk_column;
       v_dist := COALESCE(auditoria_uuid(v_dist_txt),
                          auditoria_uuid(current_setting('splg.distributor_id', true)));
     END IF;
     -- Una distribuidora que ya no existe (se borró ella o sus hijas en
     -- cascada) no puede ir a la FK: queda nula y el id en un detalle.
     IF v_dist IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM distributor WHERE distributor_id = v_dist) THEN
       IF NOT ('distributorId' = ANY (v_campos)) THEN
         v_campos := array_append(v_campos, 'distributorId');
         v_viejos := array_append(v_viejos, v_dist::text);
         v_nuevos := array_append(v_nuevos, NULL::text);
       END IF;
       v_dist := NULL;
     END IF;
     v_user := auditoria_uuid(current_setting('splg.user_id', true));
     IF v_user IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "user" WHERE user_id = v_user) THEN
       v_user := NULL;
     END IF;

     v_audit := gen_random_uuid();
     INSERT INTO audit
       (audit_id, action_type_id, user_id, distributor_id, entity, record_id, ip,
        source, table_name, db_user, app_name)
     VALUES
       (v_audit, v_accion, v_user, v_dist, v_ent.entity, COALESCE(v_record, ''),
        left(NULLIF(current_setting('splg.ip', true), ''), 45),
        'db', TG_TABLE_NAME, current_user::text,
        left(NULLIF(current_setting('application_name', true), ''), 63));
     IF cardinality(v_campos) > 0 THEN
       INSERT INTO audit_detail (audit_detail_id, audit_id, field, old_value, new_value)
       SELECT gen_random_uuid(), v_audit, t.f, t.o, t.n
         FROM unnest(v_campos, v_viejos, v_nuevos) AS t(f, o, n);
     END IF;
     RETURN NULL;
   END
   $$`,

  // Instala (o reinstala) el trigger en una tabla. Toda tabla nueva de negocio
  // lo recibe cargando su mapa con auditoria_aplicar_mapa.
  `CREATE OR REPLACE FUNCTION auditoria_instalar(p_tabla text) RETURNS void
   LANGUAGE plpgsql AS $$
   BEGIN
     EXECUTE format('DROP TRIGGER IF EXISTS "TRG_auditoria" ON public.%I', p_tabla);
     EXECUTE format(
       'CREATE TRIGGER "TRG_auditoria" AFTER INSERT OR UPDATE OR DELETE ON public.%I
          FOR EACH ROW EXECUTE FUNCTION auditoria_trigger()', p_tabla);
   END
   $$`,

  `CREATE OR REPLACE FUNCTION auditoria_desinstalar(p_tabla text) RETURNS void
   LANGUAGE plpgsql AS $$
   BEGIN
     EXECUTE format('DROP TRIGGER IF EXISTS "TRG_auditoria" ON public.%I', p_tabla);
   END
   $$`,

  // Carga el mapa generado (ver scripts/auditoria-mapa.ts) e instala el trigger
  // en todas sus tablas. Idempotente.
  `CREATE OR REPLACE FUNCTION auditoria_aplicar_mapa(p_mapa jsonb) RETURNS void
   LANGUAGE plpgsql AS $$
   DECLARE
     e jsonb;
   BEGIN
     FOR e IN SELECT jsonb_array_elements(p_mapa -> 'entities') LOOP
       INSERT INTO audit_entity_map
         (table_name, entity, pk_columns, delete_column, distributor_mode,
          distributor_column, parent_table, parent_fk_column, parent_pk_column,
          parent_distributor_column, order_property, order_column)
       VALUES
         (e ->> 'table', e ->> 'entity',
          ARRAY(SELECT x FROM jsonb_array_elements_text(e -> 'pk') WITH ORDINALITY AS t(x, i) ORDER BY i),
          e ->> 'deleteColumn', e ->> 'distributorMode', e ->> 'distributorColumn',
          e ->> 'parentTable', e ->> 'parentFkColumn', e ->> 'parentPkColumn',
          e ->> 'parentDistributorColumn', e ->> 'orderProperty', e ->> 'orderColumn')
       ON CONFLICT (table_name) DO UPDATE SET
         entity = EXCLUDED.entity, pk_columns = EXCLUDED.pk_columns,
         delete_column = EXCLUDED.delete_column,
         distributor_mode = EXCLUDED.distributor_mode,
         distributor_column = EXCLUDED.distributor_column,
         parent_table = EXCLUDED.parent_table,
         parent_fk_column = EXCLUDED.parent_fk_column,
         parent_pk_column = EXCLUDED.parent_pk_column,
         parent_distributor_column = EXCLUDED.parent_distributor_column,
         order_property = EXCLUDED.order_property,
         order_column = EXCLUDED.order_column;
       DELETE FROM audit_field_map WHERE table_name = e ->> 'table';
     END LOOP;
     INSERT INTO audit_field_map (table_name, column_name, property, secret, kind, position)
     SELECT f."table", f."column", f.property, f.secret, f.kind, f.position
       FROM jsonb_to_recordset(p_mapa -> 'fields')
         AS f("table" text, "column" text, property text, secret boolean, kind text, position integer);
     PERFORM auditoria_instalar(table_name)
       FROM audit_entity_map
      WHERE to_regclass('public.' || quote_ident(table_name)) IS NOT NULL;
   END
   $$`,
];

/**
 * La auditoría tampoco se vacía: TRUNCATE sobre `audit` y `audit_detail` (también
 * en cascada desde otra tabla) se rechaza. Sólo la migración lo instala: los e2e
 * que truncan todo trabajan sobre un esquema sincronizado que no lo trae, y si
 * se corren sobre uno migrado lo deshabilitan en su contenedor.
 */
export const CREAR_BLOQUEO_DE_TRUNCATE = [
  `CREATE OR REPLACE FUNCTION audit_datos_sin_truncate() RETURNS trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION '% es de sólo escritura: no se vacía la auditoría', TG_TABLE_NAME;
   END
   $$`,
  `CREATE TRIGGER audit_sin_truncate BEFORE TRUNCATE ON "audit"
     FOR EACH STATEMENT EXECUTE FUNCTION audit_datos_sin_truncate()`,
  `CREATE TRIGGER audit_detail_sin_truncate BEFORE TRUNCATE ON "audit_detail"
     FOR EACH STATEMENT EXECUTE FUNCTION audit_datos_sin_truncate()`,
];
