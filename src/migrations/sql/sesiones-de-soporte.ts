/**
 * Modo soporte: lo que la base asegura además de las columnas y los CHECK de
 * las entidades. Lo comparten la migración `SesionesDeSoporte` y el arranque
 * de las pruebas de integración (que sincronizan el esquema desde las
 * entidades).
 *
 *  - Una sola sesión activa por administrador general y una sola pendiente por
 *    administrador y empresa (únicos parciales: dos pedidos simultáneos no
 *    pasan los dos).
 *  - `support_access` es de sólo agregar, con el mismo criterio que
 *    `audit_log`: un trigger rechaza UPDATE y DELETE.
 */
export const CREAR_INDICES_DE_SOPORTE: readonly string[] = [
  `CREATE UNIQUE INDEX "UQ_support_session_activa" ON "support_session" ("requested_by") WHERE "status" = 'active'`,
  `CREATE UNIQUE INDEX "UQ_support_session_pendiente" ON "support_session" ("requested_by", "distributor_id") WHERE "status" = 'pending'`,
];

export const CREAR_REGISTRO_DE_SOPORTE_INMUTABLE: readonly string[] = [
  `CREATE OR REPLACE FUNCTION support_access_inmutable() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION 'support_access es de sólo escritura: no se modifican ni se borran registros';
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER support_access_inmutable
   BEFORE UPDATE OR DELETE ON "support_access"
   FOR EACH ROW EXECUTE FUNCTION support_access_inmutable()`,
];

export function sentenciasDeSoporte(): string[] {
  return [...CREAR_INDICES_DE_SOPORTE, ...CREAR_REGISTRO_DE_SOPORTE_INMUTABLE];
}

export function sentenciasParaQuitarSoporte(): string[] {
  return [
    `DROP TRIGGER IF EXISTS support_access_inmutable ON "support_access"`,
    `DROP FUNCTION IF EXISTS support_access_inmutable()`,
    `DROP INDEX IF EXISTS "UQ_support_session_pendiente"`,
    `DROP INDEX IF EXISTS "UQ_support_session_activa"`,
  ];
}
