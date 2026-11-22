/** Componentes que muestra la página de estado, en el orden en que se listan. */
export const COMPONENTES = [
  'api',
  'postgres',
  'redis',
  'memory_rss',
  'storage',
] as const;

export type Componente = (typeof COMPONENTES)[number];

export type EstadoComponente = 'up' | 'down';

export type EstadoDeComponentes = Record<Componente, EstadoComponente>;

/** Nombre y aclaración que se ve en la página (sin datos internos). */
export const ETIQUETAS: Record<
  Componente,
  { nombre: string; detalle: string }
> = {
  api: { nombre: 'API', detalle: 'Pedidos, despacho y paneles' },
  postgres: { nombre: 'Base de datos', detalle: 'PostgreSQL' },
  redis: { nombre: 'Redis', detalle: 'Caché y colas' },
  memory_rss: { nombre: 'Memoria', detalle: 'Uso del servidor' },
  storage: { nombre: 'Almacenamiento', detalle: 'Espacio en disco' },
};

export type EstadoGeneral = 'ok' | 'parcial' | 'caida';

/**
 * Base de datos caída: la API no puede atender y es una caída; cualquier otro
 * componente caído es funcionamiento parcial.
 */
export function estadoGeneral(estados: EstadoDeComponentes): EstadoGeneral {
  if (estados.postgres === 'down') return 'caida';
  return COMPONENTES.some((c) => estados[c] === 'down') ? 'parcial' : 'ok';
}
