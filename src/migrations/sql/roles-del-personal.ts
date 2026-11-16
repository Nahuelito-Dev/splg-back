/**
 * Roles del personal del panel (F37): lo que la base asegura además del back.
 * Lo comparten la migración `RolesDelPersonal` y el arranque de las pruebas de
 * integración (que sincronizan el esquema desde las entidades).
 *
 *  - Cada distribuidora tiene un rol de sistema «Administrador»: lo crea
 *    `staff_role_de_sistema` (idempotente) al dar de alta la distribuidora.
 *  - Todo admin de una distribuidora tiene rol de personal: si el alta no lo
 *    indica, el de sistema. El super admin (sin distribuidora) no tiene.
 *  - Únicos entre los vigentes: el nombre por distribuidora sin distinguir
 *    mayúsculas y un solo rol de sistema por distribuidora.
 */
export const NOMBRE_DEL_ROL_DE_SISTEMA_EN_LA_BASE = 'Administrador';

export const CREAR_INDICES_DE_ROLES_DEL_PERSONAL: readonly string[] = [
  `CREATE UNIQUE INDEX "UQ_staff_role_nombre_vigente" ON "staff_role" ("distributor_id", lower("name")) WHERE "deletedAt" IS NULL`,
  `CREATE UNIQUE INDEX "UQ_staff_role_sistema_vigente" ON "staff_role" ("distributor_id") WHERE "is_system" AND "deletedAt" IS NULL`,
];

export const CREAR_FUNCIONES_DE_ROLES_DEL_PERSONAL: readonly string[] = [
  `CREATE OR REPLACE FUNCTION staff_role_de_sistema(p_distributor uuid)
   RETURNS uuid LANGUAGE plpgsql AS $$
   DECLARE
     v_id uuid;
   BEGIN
     SELECT "staff_role_id" INTO v_id FROM "staff_role"
      WHERE "distributor_id" = p_distributor AND "is_system" AND "deletedAt" IS NULL;
     IF v_id IS NOT NULL THEN
       RETURN v_id;
     END IF;
     -- Dos altas simultáneas chocan con UQ_staff_role_sistema_vigente: la
     -- segunda no inserta y lee el que creó la primera.
     INSERT INTO "staff_role" ("distributor_id", "name", "description", "permissions", "is_system")
     VALUES (p_distributor, '${NOMBRE_DEL_ROL_DE_SISTEMA_EN_LA_BASE}',
             'Todos los permisos. Rol de sistema: no se edita ni se da de baja.', '{}', true)
     ON CONFLICT DO NOTHING
     RETURNING "staff_role_id" INTO v_id;
     IF v_id IS NULL THEN
       SELECT "staff_role_id" INTO v_id FROM "staff_role"
        WHERE "distributor_id" = p_distributor AND "is_system" AND "deletedAt" IS NULL;
     END IF;
     RETURN v_id;
   END $$`,
  `CREATE OR REPLACE FUNCTION distribuidora_con_rol_de_sistema()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     PERFORM staff_role_de_sistema(NEW."distributor_id");
     RETURN NULL;
   END $$`,
  // En el alta sin rol, el de sistema. Al cambiar de distribuidora sin indicar
  // rol (el seed completa admins viejos sin distribuidora), el de sistema de la
  // nueva. Quitarle el rol a un admin con distribuidora no pasa: lo frena
  // CHK_admin_rol_de_personal (no se le da «todos los permisos» por omisión).
  `CREATE OR REPLACE FUNCTION admin_con_rol_de_personal()
   RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW."distributor_id" IS NULL THEN
       NEW."staff_role_id" := NULL;
     ELSIF TG_OP = 'INSERT' AND NEW."staff_role_id" IS NULL THEN
       NEW."staff_role_id" := staff_role_de_sistema(NEW."distributor_id");
     ELSIF TG_OP = 'UPDATE'
       AND NEW."distributor_id" IS DISTINCT FROM OLD."distributor_id"
       AND NEW."staff_role_id" IS NOT DISTINCT FROM OLD."staff_role_id" THEN
       NEW."staff_role_id" := staff_role_de_sistema(NEW."distributor_id");
     END IF;
     RETURN NEW;
   END $$`,
];

export const CREAR_TRIGGERS_DE_ROLES_DEL_PERSONAL: readonly string[] = [
  `CREATE TRIGGER "TRG_distributor_rol_de_sistema" AFTER INSERT ON "distributor"
   FOR EACH ROW EXECUTE FUNCTION distribuidora_con_rol_de_sistema()`,
  `CREATE TRIGGER "TRG_admin_rol_de_personal" BEFORE INSERT OR UPDATE OF "distributor_id" ON "admin"
   FOR EACH ROW EXECUTE FUNCTION admin_con_rol_de_personal()`,
];

/** Lo que hace falta sobre un esquema ya creado (migración o `DB_SYNC` de las pruebas). */
export function sentenciasDeRolesDelPersonal(): string[] {
  return [
    ...CREAR_INDICES_DE_ROLES_DEL_PERSONAL,
    ...CREAR_FUNCIONES_DE_ROLES_DEL_PERSONAL,
    ...CREAR_TRIGGERS_DE_ROLES_DEL_PERSONAL,
  ];
}

export function sentenciasParaQuitarRolesDelPersonal(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "TRG_admin_rol_de_personal" ON "admin"`,
    `DROP TRIGGER IF EXISTS "TRG_distributor_rol_de_sistema" ON "distributor"`,
    `DROP FUNCTION IF EXISTS admin_con_rol_de_personal()`,
    `DROP FUNCTION IF EXISTS distribuidora_con_rol_de_sistema()`,
    `DROP FUNCTION IF EXISTS staff_role_de_sistema(uuid)`,
    `DROP INDEX IF EXISTS "UQ_staff_role_sistema_vigente"`,
    `DROP INDEX IF EXISTS "UQ_staff_role_nombre_vigente"`,
  ];
}
