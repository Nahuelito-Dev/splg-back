import { ClaimsService } from '../../claims/claims.service';
import { ClaimMapper } from '../../claims/claims.mapper';
import type { ClaimResponseDto } from '../../claims/dto/claim-response.dto';
import type { IncidentResponseDto } from '../../incident/dto/incident-response.dto';
import { IncidentMapper } from '../../incident/incident.mapper';
import { IncidentService } from '../../incident/incident.service';
import type { FuenteDeExporte } from '../export.types';
import { codigo, fechaHora, opcion, texto } from './columnas';
import { fuente, SinFiltros } from './fuente';

export interface ServiciosDeAtencion {
  claims: ClaimsService;
  incidents: IncidentService;
}

export function fuentesDeAtencion(s: ServiciosDeAtencion): FuenteDeExporte[] {
  return [
    fuente<SinFiltros, ClaimResponseDto>({
      recurso: 'reclamos',
      descripcion: 'Reclamos de clientes',
      query: SinFiltros,
      leer: async (_query, distribuidoraId) => {
        const reclamos = await s.claims.findAll(distribuidoraId);
        return {
          filas: reclamos.map((c) => ClaimMapper.toDto(c)),
          total: reclamos.length,
        };
      },
      columnas: [
        fechaHora('Fecha', (c) => c.createdAt),
        codigo('Pedido', (c) => c.order_id, 38),
        texto('Cliente', (c) => c.customer?.full_name),
        codigo('Teléfono del cliente', (c) => c.customer?.phone_number),
        texto('Motivo', (c) => c.reason),
        texto('Descripción', (c) => c.description, 44),
        opcion('Estado', 'status', (c) => c.status),
        texto('Resolución', (c) => c.resolutionNote, 36),
      ],
    }),

    fuente<SinFiltros, IncidentResponseDto>({
      recurso: 'incidencias',
      descripcion: 'Incidencias de entrega',
      query: SinFiltros,
      leer: async (_query, distribuidoraId) => {
        const incidencias = await s.incidents.findAll(distribuidoraId);
        return {
          filas: incidencias.map((i) => IncidentMapper.toDto(i)),
          total: incidencias.length,
        };
      },
      columnas: [
        fechaHora('Fecha', (i) => i.createdAt),
        codigo('Pedido', (i) => i.order_id, 38),
        opcion('Tipo', 'type', (i) => i.type),
        texto('Descripción', (i) => i.description, 44),
        opcion('Estado', 'status', (i) => i.status),
        texto('Resolución', (i) => i.resolution_note, 36),
        fechaHora('Resuelta', (i) => i.resolvedAt),
      ],
    }),
  ];
}
