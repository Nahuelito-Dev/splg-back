import { CREAR_ADJUNTOS_DEL_CHAT } from './adjuntos-del-chat';

/**
 * Reintento del escaneo de los adjuntos del chat (corrección 1 de CH7). Lo
 * comparten la migración `ReintentoDelEscaneo` y el arranque de las pruebas de
 * integración (después de `sql/adjuntos-del-chat.ts`).
 *
 * `attachment_escaneo` (`TRG_attachment_escaneo`): `pending` pasa a `clean`,
 * `infected` o `failed`; `failed` ya no es final: se reintenta (`pending`) o
 * se resuelve (`clean`, `infected`). `clean` e `infected` sí son finales. Los
 * intentos (`scan_attempts`) nunca bajan.
 */
export const CREAR_REINTENTO_DEL_ESCANEO: readonly string[] = [
  `CREATE OR REPLACE FUNCTION attachment_escaneo() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW."scan_status" IS DISTINCT FROM OLD."scan_status" AND NOT (
          (OLD."scan_status" = 'pending' AND NEW."scan_status" IN ('clean', 'infected', 'failed'))
          OR (OLD."scan_status" = 'failed' AND NEW."scan_status" IN ('pending', 'clean', 'infected'))) THEN
       RAISE EXCEPTION 'El escaneo de un archivo pasa de pendiente o fallido a limpio, infectado o fallido; limpio e infectado son finales'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_attachment_escaneo_transicion';
     END IF;
     IF NEW."scan_attempts" < OLD."scan_attempts" THEN
       RAISE EXCEPTION 'Los intentos de escaneo de un archivo no bajan'
         USING ERRCODE = '23514', CONSTRAINT = 'CHK_attachment_intentos_no_bajan';
     END IF;
     RETURN NEW;
   END $$`,
  `DROP TRIGGER IF EXISTS "TRG_attachment_escaneo" ON "attachment"`,
  `CREATE TRIGGER "TRG_attachment_escaneo" BEFORE UPDATE OF "scan_status", "scan_attempts" ON "attachment"
   FOR EACH ROW EXECUTE FUNCTION attachment_escaneo()`,
];

export function sentenciasDelReintentoDelEscaneo(): string[] {
  return [...CREAR_REINTENTO_DEL_ESCANEO];
}

/** Vuelve a la función y al trigger de `AdjuntosDelChat` (`failed` final). */
export function sentenciasParaQuitarElReintentoDelEscaneo(): string[] {
  return [
    `DROP TRIGGER IF EXISTS "TRG_attachment_escaneo" ON "attachment"`,
    ...CREAR_ADJUNTOS_DEL_CHAT.filter(
      (s) =>
        s.includes('FUNCTION attachment_escaneo()') ||
        s.includes('TRIGGER "TRG_attachment_escaneo"'),
    ).map((s) =>
      s.replace(
        'CREATE FUNCTION attachment_escaneo()',
        'CREATE OR REPLACE FUNCTION attachment_escaneo()',
      ),
    ),
  ];
}
