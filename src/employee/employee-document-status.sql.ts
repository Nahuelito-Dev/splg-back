import { EmployeeDocumentStatus } from './domain/document-status';

/**
 * Estado de la documentación de un legajo calculado en la base (CU-180), para
 * poder filtrar y paginar sin traer a todo el personal. Replica las reglas de
 * `EmployeeDocumentsService` (CU-187):
 *
 * - tareas abiertas: las del legajo y las de su perfil de reparto (la licencia),
 *   que no estén hechas ni canceladas;
 * - vencida: pasó el fin del día de `due_at` en hora argentina (+27 h sobre la
 *   medianoche UTC, ver `finDeVigenciaEnArgentina`);
 * - por vencer: dentro de los `lead_time_days` del plan;
 * - faltante: un plan activo de empleado o de chofer que le aplica por la
 *   categoría de su puesto (`aplicaALaCategoria`) y no tiene tarea abierta.
 *
 * Precedencia: vencida, faltante, por vencer, al día. Un legajo egresado no
 * tiene estado (`NULL`). Espera los alias `e` (employee) y `p` (job_position).
 */
const TAREAS_ABIERTAS = `
  FROM maintenance_task t
  INNER JOIN maintenance_plan pl ON pl.plan_id = t.plan_id
  WHERE t.distributor_id = e.distributor_id
    AND t.status NOT IN ('done', 'cancelled')
    AND (
      t.employee_id = e.employee_id
      OR t.delivery_id IN (
        SELECT d.delivery_id FROM delivery d
        WHERE d.user_id = e.user_id AND d.distributor_id = e.distributor_id
          AND d."deletedAt" IS NULL
      )
    )`;

const VENCIDA = `t.due_at IS NOT NULL AND now() >= t.due_at + interval '27 hours'`;
const POR_VENCER = `t.due_at IS NOT NULL AND now() >= t.due_at - make_interval(days => pl.lead_time_days)`;

const PLAN_QUE_LE_APLICA = `
  pl2.distributor_id = e.distributor_id
  AND pl2.is_active
  AND pl2.subject IN ('employee', 'driver')
  AND CASE
    WHEN pl2.applies_to_categories IS NULL OR cardinality(pl2.applies_to_categories) = 0
      THEN (pl2.subject <> 'driver' OR p.category::text = 'driver')
    ELSE p.category::text = ANY (pl2.applies_to_categories)
  END`;

export const SQL_ESTADO_DE_DOCUMENTACION = `CASE
  WHEN e.status <> 'active' THEN NULL
  WHEN EXISTS (SELECT 1 ${TAREAS_ABIERTAS} AND ${VENCIDA})
    THEN '${EmployeeDocumentStatus.EXPIRED}'
  WHEN EXISTS (
    SELECT 1 FROM maintenance_plan pl2
    WHERE ${PLAN_QUE_LE_APLICA}
      AND NOT EXISTS (SELECT 1 ${TAREAS_ABIERTAS} AND t.plan_id = pl2.plan_id)
  ) THEN '${EmployeeDocumentStatus.MISSING}'
  WHEN EXISTS (SELECT 1 ${TAREAS_ABIERTAS} AND ${POR_VENCER})
    THEN '${EmployeeDocumentStatus.DUE_SOON}'
  ELSE '${EmployeeDocumentStatus.UP_TO_DATE}'
END`;

/** El vencimiento más cercano entre los documentos abiertos con fecha (`YYYY-MM-DD`), sólo para legajos activos. */
export const SQL_PROXIMO_VENCIMIENTO = `CASE WHEN e.status = 'active' THEN (
  SELECT to_char(MIN(t.due_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  ${TAREAS_ABIERTAS} AND t.due_at IS NOT NULL
) END`;
