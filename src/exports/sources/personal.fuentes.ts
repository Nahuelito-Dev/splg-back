import { AuditService } from '../../audit/audit.service';
import { AuditMapper } from '../../audit/audit.mapper';
import { DataAuditService } from '../../audit/data/data-audit.service';
import { QueryAuditEntriesV2Dto } from '../../audit/data/data-audit.dto';
import type {
  AuditEntryDto,
  AuditEntryV2Dto,
  OrigenDeAuditoria,
} from '../../audit/data/data-audit.dto';
import { ConsultarAuditoriaDto } from '../../audit/dto/consultar-auditoria.dto';
import type { AsientoDeAuditoriaDto } from '../../audit/dto/audit-log-response.dto';
import { QueryEmployeeDto } from '../../employee/dto/query-employee.dto';
import type { EmployeeListRowDto } from '../../employee/dto/employee-response.dto';
import { ETIQUETA_DE_DOCUMENTACION } from '../../employee/domain/document-status';
import { EmployeeMapper } from '../../employee/employee.mapper';
import { EmployeeService } from '../../employee/employee.service';
import type { FuenteDeExporte } from '../export.types';
import {
  booleano,
  codigo,
  entero,
  entidad,
  fecha,
  fechaHora,
  opcion,
  texto,
} from './columnas';
import mapaDeAuditoria from '../../audit/data/auditoria-mapa.datos.json';
import { fuente, porOffset, porPagina } from './fuente';

/** Los cambios de un asiento de auditoría de datos, en una celda. */
const MAXIMO_DE_CAMBIOS = 4000;

const VALOR_OCULTO = 'valor oculto';

/** Campos que no salen en un archivo: identificadores personales, claves y tokens. */
const CAMPO_SENSIBLE =
  /cbu|cuil|cuit|document|dni|firebase|token|password|secret|key/i;

/** Tabla auditada → nombre de su entidad (la columna «Tabla» sale con el mismo nombre que «Entidad»). */
const ENTIDAD_DE_TABLA: ReadonlyMap<string, string> = new Map(
  mapaDeAuditoria.entities.map((e) => [e.table, e.entity]),
);

const ORIGEN: Record<OrigenDeAuditoria, string> = {
  user: 'Usuario',
  system: 'Sistema (automático)',
  direct: 'Directo en la base',
};

function cambiosDe(entrada: AuditEntryDto): string {
  const valor = (campo: string, v: string | null): string =>
    CAMPO_SENSIBLE.test(campo) ? VALOR_OCULTO : (v ?? '∅');
  return entrada.details
    .map(
      (d) =>
        `${d.field}: ${valor(d.field, d.oldValue)} → ${valor(d.field, d.newValue)}`,
    )
    .join(' | ')
    .slice(0, MAXIMO_DE_CAMBIOS);
}

export interface ServiciosDePersonal {
  employees: EmployeeService;
  audit: AuditService;
  dataAudit: DataAuditService;
}

export function fuentesDePersonal(s: ServiciosDePersonal): FuenteDeExporte[] {
  return [
    fuente<QueryEmployeeDto, EmployeeListRowDto>({
      recurso: 'legajos',
      descripcion:
        'Legajos del personal, sin datos personales sensibles (mismos filtros que GET /employees)',
      query: QueryEmployeeDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.employees.findAll(query, distribuidoraId);
        return {
          filas: r.data.map((e) =>
            EmployeeMapper.toListItem(
              e,
              r.documentacion.get(e.employeeId) ?? {
                estado: null,
                proximoVencimiento: null,
              },
            ),
          ),
          total: r.total,
        };
      },
      columnas: [
        codigo('Legajo', (e) => e.fileNumber),
        texto('Apellido', (e) => e.lastName),
        texto('Nombre', (e) => e.firstName),
        texto('Puesto', (e) => e.position.name),
        opcion('Categoría', 'category', (e) => e.position.category),
        opcion('Estado', 'status', (e) => e.status),
        fecha('Ingreso', (e) => e.hireDate),
        booleano('Tiene cuenta', (e) => e.hasAccount),
        texto('Documentación', (e) =>
          e.documentStatus ? ETIQUETA_DE_DOCUMENTACION[e.documentStatus] : null,
        ),
        fecha('Próximo vencimiento', (e) => e.nextDocumentDueDate),
      ],
    }),

    fuente<ConsultarAuditoriaDto, AsientoDeAuditoriaDto>({
      recurso: 'auditoria',
      descripcion: 'Auditoría de operaciones (mismos filtros que GET /audit)',
      query: ConsultarAuditoriaDto,
      paginar: porOffset,
      leer: async (query, distribuidoraId) => {
        const r = await s.audit.consultar(query, distribuidoraId);
        return {
          filas: r.items.map((a) => AuditMapper.toDto(a)),
          total: r.total,
        };
      },
      columnas: [
        fechaHora('Fecha', (a) => a.createdAt),
        texto('Método', (a) => a.httpMethod),
        texto('Recurso', (a) => a.resource),
        codigo('Id del recurso', (a) => a.resourceId, 38),
        texto('Ruta', (a) => a.path, 40),
        codigo('Usuario', (a) => a.actorUserId, 38),
        opcion('Rol', 'role', (a) => a.actorRole),
        texto('Aplicación', (a) => a.clientSource),
        texto('IP', (a) => a.ip),
        opcion('Resultado', 'result', (a) => a.result),
        entero('Código HTTP', (a) => a.statusCode),
        texto('Error', (a) => a.errorMessage, 40),
      ],
    }),

    fuente<QueryAuditEntriesV2Dto, AuditEntryV2Dto>({
      recurso: 'auditoria-datos',
      descripcion:
        'Auditoría de datos, con los cambios campo por campo (mismos filtros que GET /api/v2/audit/entries, incluido origin)',
      query: QueryAuditEntriesV2Dto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.dataAudit.findAllV2(query, distribuidoraId);
        return { filas: r.data, total: r.total };
      },
      columnas: [
        fechaHora('Fecha', (a) => a.dateTime),
        texto('Acción', (a) => a.actionType.name),
        texto('Usuario', (a) => a.user?.fullName),
        texto('Email del usuario', (a) => a.user?.email),
        entidad('Entidad', (a) => a.entity),
        codigo('Registro', (a) => a.recordId, 38),
        texto('IP', (a) => a.ip),
        texto('Origen', (a) => ORIGEN[a.origin]),
        texto('Escrito por', (a) =>
          a.source === 'db' ? 'Base de datos (trigger)' : 'Aplicación',
        ),
        entidad('Tabla', (a) =>
          a.tableName === null
            ? null
            : (ENTIDAD_DE_TABLA.get(a.tableName) ?? a.tableName),
        ),
        texto('Usuario de la base', (a) => a.dbUser),
        texto('Aplicación', (a) => a.appName),
        texto('Cambios', cambiosDe, 60),
      ],
    }),
  ];
}
