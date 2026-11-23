/**
 * Los procesos automáticos que se monitorean (F31): uno por tarea programada
 * (`@Cron`) del back. Los valores son los del enum `process_run_process_enum`
 * de la base: agregar uno exige migración.
 */
export enum ProcessName {
  DISPATCH_TICK = 'dispatch_tick',
  FLEET_PLANNER_DAILY = 'fleet_planner_daily',
  FLEET_PLANNER_EXPIRY = 'fleet_planner_expiry',
  VEHICLE_USAGE_FEED = 'vehicle_usage_feed',
  REPURCHASE_ANTICIPATE = 'repurchase_anticipate',
  REPURCHASE_EXPIRY = 'repurchase_expiry',
  ROUTE_BATCH_BUILD = 'route_batch_build',
  ROUTE_BATCH_EXPIRY = 'route_batch_expiry',
  CYLINDER_RECOVERY = 'cylinder_recovery',
  ATTENDANCE_OPEN_ALERT = 'attendance_open_alert',
  RECEIVER_RETENTION = 'receiver_retention',
  MP_PENDING_RECONCILIATION = 'mp_pending_reconciliation',
  MP_CANCELLED_RECONCILIATION = 'mp_cancelled_reconciliation',
  RESERVATIONS_ACTIVATE = 'reservations_activate',
  RESERVATIONS_EXPIRE_UNPAID = 'reservations_expire_unpaid',
  ORDERS_EXPIRE_MP_UNPAID = 'orders_expire_mp_unpaid',
  PAYMENT_INBOX_PROCESS = 'payment_inbox_process',
  PAYMENT_INBOX_PURGE = 'payment_inbox_purge',
  S3_ORPHANS_RETRY = 's3_orphans_retry',
  DRIVER_SETTLEMENT_GENERATE = 'driver_settlement_generate',
  DRIVER_SETTLEMENT_ALERT = 'driver_settlement_alert',
  DRIVER_CASH_ALERT = 'driver_cash_alert',
  COVERAGE_ZONE_EXPIRY = 'coverage_zone_expiry',
  FINE_DUE_ALERTS = 'fine_due_alerts',
  FINANCE_RECONCILIATION = 'finance_reconciliation',
  MP_RECONCILIATION_SYNC = 'mp_reconciliation_sync',
  FLEET_ALERTS = 'fleet_alerts',
  STOCK_LOW_ALERT = 'stock_low_alert',
  STOCK_RECONCILIATION = 'stock_reconciliation',
  INSURANCE_ALERTS = 'insurance_alerts',
  IMPORT_CLEANUP = 'import_cleanup',
  PROCESS_RUN_WATCH = 'process_run_watch',
  PROCESS_RUN_PURGE = 'process_run_purge',
  DOCUMENT_READING = 'document_reading',
  DOCUMENT_READING_PROPOSALS = 'document_reading_proposals',
  ROUTE_PLANNING_PROPOSE = 'route_planning_propose',
  ROUTE_PLANNING_CLOSE_DAYS = 'route_planning_close_days',
  ROUTE_SHEET_WATCH = 'route_sheet_watch',
  SUPPORT_SESSION_EXPIRY = 'support_session_expiry',
  SUPPORT_HOUSEKEEPING = 'support_housekeeping',
  ASSISTANT_AI_SWEEP = 'assistant_ai_sweep',
  CHAT_ATTACHMENT_SCAN = 'chat_attachment_scan',
  CHAT_INACTIVITY_CLOSE = 'chat_inactivity_close',
  CHAT_AUTO_ASSIGN = 'chat_auto_assign',
}

export enum ProcessRunStatus {
  RUNNING = 'running',
  OK = 'ok',
  PARTIAL = 'partial',
  FAILED = 'failed',
  /** No hizo nada: otra instancia tenía el cerrojo. No cuenta para la salud. */
  SKIPPED = 'skipped',
}

export enum RunTrigger {
  CRON = 'cron',
  MANUAL = 'manual',
  /** Adelantada por un webhook; no es la corrida del cron. */
  WEBHOOK = 'webhook',
}

/** Lo que el panel muestra: el estado de la última corrida más las alertas. */
export enum ProcessHealth {
  OK = 'ok',
  PARTIAL = 'partial',
  RUNNING = 'running',
  FAILED = 'failed',
  LATE = 'late',
  STUCK = 'stuck',
  NEVER = 'never',
}

export interface ProcessCatalogEntry {
  /** Módulo inteligente al que pertenece (M1..M5) o `null` si es una tarea programada común. */
  module: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | null;
  title: string;
  /** Cada cuánto corre su `@Cron`, en segundos. Es lo que se espera ver registrado. */
  periodSeconds: number;
  /**
   * Si corre más seguido que esto, sólo se registra una corrida cada tanto
   * (una por tic de 15 s serían 5.760 filas por día). El período esperado es
   * el del registro.
   */
  recordEverySeconds?: number;
}

const MIN = 60;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

export const CATALOGO: Readonly<Record<ProcessName, ProcessCatalogEntry>> = {
  [ProcessName.DRIVER_CASH_ALERT]: {
    module: null,
    title: 'Aviso de efectivo cobrado sin rendir',
    periodSeconds: HORA,
  },
  [ProcessName.DOCUMENT_READING_PROPOSALS]: {
    module: 'M6',
    title: 'Lectura de documentos: vencimiento de propuestas',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.DOCUMENT_READING]: {
    module: 'M6',
    title: 'Lectura de documentos',
    periodSeconds: MIN,
  },
  [ProcessName.DISPATCH_TICK]: {
    module: 'M1',
    title: 'Despacho: tic de asignación y ofertas',
    periodSeconds: 15,
    recordEverySeconds: 5 * MIN,
  },
  [ProcessName.FLEET_PLANNER_DAILY]: {
    module: 'M2',
    title: 'Planificador de taller: propuestas',
    periodSeconds: HORA,
  },
  [ProcessName.FLEET_PLANNER_EXPIRY]: {
    module: 'M2',
    title: 'Planificador de taller: vencimiento de propuestas',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.VEHICLE_USAGE_FEED]: {
    module: 'M2',
    title: 'Planificador de taller: uso diario de vehículos',
    periodSeconds: DIA,
  },
  [ProcessName.REPURCHASE_ANTICIPATE]: {
    module: 'M3',
    title: 'Recompra: invitaciones anticipadas',
    periodSeconds: HORA,
  },
  [ProcessName.REPURCHASE_EXPIRY]: {
    module: 'M3',
    title: 'Recompra: vencimiento de invitaciones',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.ROUTE_BATCH_BUILD]: {
    module: 'M4',
    title: 'Recorridos: armado de lotes',
    periodSeconds: MIN,
    recordEverySeconds: 5 * MIN,
  },
  [ProcessName.ROUTE_PLANNING_PROPOSE]: {
    module: 'M4',
    title: 'Hoja de ruta: propuesta y confirmación del día siguiente',
    periodSeconds: MIN,
    recordEverySeconds: 5 * MIN,
  },
  [ProcessName.ROUTE_PLANNING_CLOSE_DAYS]: {
    module: 'M4',
    title: 'Hoja de ruta: cierre de los días',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.ROUTE_SHEET_WATCH]: {
    module: 'M4',
    title: 'Hoja de ruta: seguimiento de las hojas en curso',
    periodSeconds: MIN,
    recordEverySeconds: 5 * MIN,
  },
  [ProcessName.ROUTE_BATCH_EXPIRY]: {
    module: 'M4',
    title: 'Recorridos: vencimiento de ofertas de lote',
    periodSeconds: 15,
    recordEverySeconds: 5 * MIN,
  },
  [ProcessName.CYLINDER_RECOVERY]: {
    module: 'M5',
    title: 'Recupero de envases',
    periodSeconds: HORA,
  },
  [ProcessName.ATTENDANCE_OPEN_ALERT]: {
    module: null,
    title: 'Aviso de jornadas sin cerrar',
    periodSeconds: DIA,
  },
  [ProcessName.RECEIVER_RETENTION]: {
    module: null,
    title: 'Anulación de datos del receptor vencidos',
    periodSeconds: DIA,
  },
  [ProcessName.MP_PENDING_RECONCILIATION]: {
    module: null,
    title: 'Conciliación de pagos de Mercado Pago pendientes',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.MP_CANCELLED_RECONCILIATION]: {
    module: null,
    title: 'Conciliación de pedidos cancelados con pago de Mercado Pago',
    periodSeconds: 15 * MIN,
  },
  [ProcessName.RESERVATIONS_ACTIVATE]: {
    module: null,
    title: 'Activación de reservas del día',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.RESERVATIONS_EXPIRE_UNPAID]: {
    module: null,
    title: 'Vencimiento de reservas sin seña',
    periodSeconds: HORA,
  },
  [ProcessName.ORDERS_EXPIRE_MP_UNPAID]: {
    module: null,
    title: 'Vencimiento de pedidos de Mercado Pago sin pagar',
    periodSeconds: 30 * MIN,
  },
  [ProcessName.PAYMENT_INBOX_PROCESS]: {
    module: null,
    title: 'Bandeja de avisos de pago: procesamiento',
    periodSeconds: 30,
    recordEverySeconds: 5 * MIN,
  },
  [ProcessName.PAYMENT_INBOX_PURGE]: {
    module: null,
    title: 'Bandeja de avisos de pago: purga',
    periodSeconds: DIA,
  },
  [ProcessName.S3_ORPHANS_RETRY]: {
    module: null,
    title: 'Limpieza de archivos huérfanos en S3',
    periodSeconds: HORA,
  },
  [ProcessName.DRIVER_SETTLEMENT_GENERATE]: {
    module: null,
    title: 'Rendiciones de choferes: generación diaria',
    periodSeconds: DIA,
  },
  [ProcessName.DRIVER_SETTLEMENT_ALERT]: {
    module: null,
    title: 'Rendiciones de choferes: aviso de las sin cerrar',
    periodSeconds: DIA,
  },
  [ProcessName.COVERAGE_ZONE_EXPIRY]: {
    module: null,
    title: 'Zonas de cobertura vencidas',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.FINE_DUE_ALERTS]: {
    module: null,
    title: 'Aviso de multas por vencer',
    periodSeconds: HORA,
  },
  [ProcessName.FINANCE_RECONCILIATION]: {
    module: null,
    title: 'Conciliación de finanzas',
    periodSeconds: DIA,
  },
  [ProcessName.MP_RECONCILIATION_SYNC]: {
    module: null,
    title: 'Sincronización de pagos de Mercado Pago',
    periodSeconds: 2 * MIN,
  },
  [ProcessName.FLEET_ALERTS]: {
    module: null,
    title: 'Aviso de vencimientos de flota',
    periodSeconds: HORA,
  },
  [ProcessName.STOCK_LOW_ALERT]: {
    module: null,
    title: 'Aviso de stock bajo',
    periodSeconds: DIA,
  },
  [ProcessName.STOCK_RECONCILIATION]: {
    module: null,
    title: 'Conciliación de stock',
    periodSeconds: DIA,
  },
  [ProcessName.INSURANCE_ALERTS]: {
    module: null,
    title: 'Aviso de cuotas y vencimientos de seguros',
    periodSeconds: HORA,
  },
  [ProcessName.IMPORT_CLEANUP]: {
    module: null,
    title: 'Limpieza de importaciones vencidas',
    periodSeconds: DIA,
  },
  [ProcessName.PROCESS_RUN_WATCH]: {
    module: null,
    title: 'Vigilancia de los procesos automáticos',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.SUPPORT_SESSION_EXPIRY]: {
    module: null,
    title: 'Modo soporte: vencimiento de sesiones y pedidos',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.SUPPORT_HOUSEKEEPING]: {
    module: null,
    title: 'Soporte: cierre de chats inactivos y de tickets vencidos',
    periodSeconds: 10 * MIN,
  },
  [ProcessName.ASSISTANT_AI_SWEEP]: {
    module: null,
    title: 'Asistente con IA: mensajes que quedaron sin atender',
    periodSeconds: MIN,
  },
  [ProcessName.CHAT_ATTACHMENT_SCAN]: {
    module: null,
    title: 'Chat: antivirus de los archivos que quedaron pendientes',
    periodSeconds: MIN,
  },
  [ProcessName.CHAT_INACTIVITY_CLOSE]: {
    module: null,
    title:
      'Chat: aviso y cierre de las conversaciones sin respuesta del cliente o del chofer',
    periodSeconds: 5 * MIN,
  },
  [ProcessName.CHAT_AUTO_ASSIGN]: {
    module: null,
    title:
      'Chat: asignación automática de las conversaciones que esperan a una persona',
    periodSeconds: MIN,
  },
  [ProcessName.PROCESS_RUN_PURGE]: {
    module: null,
    title: 'Purga del historial de corridas',
    periodSeconds: DIA,
  },
};

/** Lo que se espera ver registrado entre una corrida y la siguiente. */
export function periodoEsperadoSeg(proceso: ProcessName): number {
  const e = CATALOGO[proceso];
  return Math.max(e.periodSeconds, e.recordEverySeconds ?? 0);
}
