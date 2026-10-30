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
import type { EmployeeListItemDto } from '../../employee/dto/employee-response.dto';
import { EmployeeMapper } from '../../employee/employee.mapper';
import { EmployeeService } from '../../employee/employee.service';
import type { FuenteDeExporte } from '../export.types';
import { booleano, codigo, entero, fecha, fechaHora, texto } from './columnas';
import { fuente, porOffset, porPagina } from './fuente';

/** Los cambios de un asiento de auditoría de datos, en una celda. */
const MAXIMO_DE_CAMBIOS = 4000;

const VALOR_OCULTO = 'valor oculto';

/** Campos que no salen en un archivo: identificadores personales, claves y tokens. */
const CAMPO_SENSIBLE =
  /cbu|cuil|cuit|document|dni|firebase|token|password|secret|key/i;

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
    fuente<QueryEmployeeDto, EmployeeListItemDto>({
      recurso: 'legajos',
      descripcion:
        'Legajos del personal, sin datos personales sensibles (mismos filtros que GET /employees)',
      query: QueryEmployeeDto,
      paginar: porPagina,
      leer: async (query, distribuidoraId) => {
        const r = await s.employees.findAll(query, distribuidoraId);
        return {
          filas: r.data.map((e) => EmployeeMapper.toListItem(e)),
          total: r.total,
        };
      },
      columnas: [
        codigo('Legajo', (e) => e.fileNumber),
        texto('Apellido', (e) => e.lastName),
        texto('Nombre', (e) => e.firstName),
        texto('Puesto', (e) => e.position.name),
        texto('Categoría', (e) => e.position.category),
        texto('Estado', (e) => e.status),
        fecha('Ingreso', (e) => e.hireDate),
        booleano('Tiene cuenta', (e) => e.hasAccount),
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
        texto('Rol', (a) => a.actorRole),
        texto('Aplicación', (a) => a.clientSource),
        texto('IP', (a) => a.ip),
        texto('Resultado', (a) => a.result),
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
        texto('Entidad', (a) => a.entity),
        codigo('Registro', (a) => a.recordId, 38),
        texto('IP', (a) => a.ip),
        texto('Origen', (a) => ORIGEN[a.origin]),
        texto('Escrito por', (a) =>
          a.source === 'db' ? 'Base de datos (trigger)' : 'Aplicación',
        ),
        texto('Tabla', (a) => a.tableName),
        texto('Usuario de la base', (a) => a.dbUser),
        texto('Aplicación', (a) => a.appName),
        texto('Cambios', cambiosDe, 60),
      ],
    }),
  ];
}
