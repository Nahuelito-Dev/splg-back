import { Componente, EstadoComponente, EstadoGeneral } from './componentes';
import { HistorialComponente } from './disponibilidad';

export interface ComponenteDePagina {
  id: Componente;
  nombre: string;
  detalle: string;
  actual: EstadoComponente;
  historial: HistorialComponente;
}

export interface ModeloPagina {
  general: EstadoGeneral;
  /** Momento de la última verificación (ms epoch). */
  verificadoEn: number;
  version: string;
  componentes: ComponenteDePagina[];
  /** `false` si no se pudo leer el historial (Redis caído). */
  historialDisponible: boolean;
}
