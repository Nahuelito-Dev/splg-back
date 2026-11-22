import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChequeosService } from './chequeos.service';
import {
  COMPONENTES,
  Componente,
  ETIQUETAS,
  estadoGeneral,
} from './componentes';
import {
  HistorialComponente,
  Muestras,
  calcularHistorial,
} from './disponibilidad';
import { HistorialStore } from './historial.store';
import { ModeloPagina } from './pagina-estado.modelo';

/** El historial cambia de a una muestra cada 5 minutos: se reutiliza unos segundos. */
const VIGENCIA_HISTORIAL_MS = 15_000;

function leerVersion(): string {
  try {
    const paquete = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version?: string };
    return paquete.version ?? 'desconocida';
  } catch {
    return 'desconocida';
  }
}

@Injectable()
export class PaginaEstadoService {
  private readonly logger = new Logger('PaginaEstado');
  private readonly version = leerVersion();
  private cache: {
    hasta: number;
    historial: Record<Componente, HistorialComponente>;
    historialDisponible: boolean;
  } | null = null;

  constructor(
    private readonly chequeos: ChequeosService,
    private readonly store: HistorialStore,
  ) {}

  /** El estado actual se chequea en cada pedido; sólo el historial se cachea. */
  async modelo(ahora: number = Date.now()): Promise<ModeloPagina> {
    const estados = await this.chequeos.estados();
    const { historial, historialDisponible } = await this.historial(ahora);
    return {
      general: estadoGeneral(estados),
      verificadoEn: ahora,
      version: this.version,
      historialDisponible,
      componentes: COMPONENTES.map((id) => ({
        id,
        nombre: ETIQUETAS[id].nombre,
        detalle: ETIQUETAS[id].detalle,
        actual: estados[id],
        historial: historial[id],
      })),
    };
  }

  private async historial(ahora: number) {
    if (this.cache && this.cache.hasta > ahora) return this.cache;
    let historialDisponible = true;
    let primeraMuestra: number | null = null;
    let muestras: Muestras = new Map();
    try {
      const leido = await this.store.leer(ahora);
      primeraMuestra = leido.primeraMuestra;
      muestras = leido.muestras;
    } catch (error) {
      historialDisponible = false;
      this.logger.warn(
        `No se pudo leer el historial: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.cache = {
      hasta: ahora + VIGENCIA_HISTORIAL_MS,
      historial: calcularHistorial({ ahora, primeraMuestra, muestras }),
      historialDisponible,
    };
    return this.cache;
  }
}
