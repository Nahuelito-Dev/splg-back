import { BloqueDeCorreo, MensajeDeCorreo } from '../../email/layout/correo';

/** Un depósito con las llenas de un tipo por debajo del mínimo. */
export interface StockBajoDelCorreo {
  deposito: string;
  garrafa: string;
  llenas: number;
  minimo: number;
}

/** Aviso diario de stock bajo. */
export function mensajeDeStockBajo(
  umbrales: readonly StockBajoDelCorreo[],
): MensajeDeCorreo {
  return {
    asunto: `Stock bajo: ${umbrales.length} garrafa(s) por debajo del mínimo`,
    preheader: `${umbrales.length} depósito(s) quedaron por debajo del mínimo de garrafas llenas.`,
    etiqueta: 'Stock',
    titulo: 'Stock bajo',
    bloques: [
      {
        tipo: 'parrafo',
        texto:
          'Estos depósitos quedaron por debajo del mínimo de garrafas llenas:',
      },
      {
        tipo: 'tabla',
        columnas: [
          { titulo: 'Depósito' },
          { titulo: 'Garrafa' },
          { titulo: 'Llenas', alinear: 'derecha', mono: true },
          { titulo: 'Mínimo', alinear: 'derecha', mono: true },
        ],
        filas: umbrales.map((u) => [
          u.deposito,
          u.garrafa,
          String(u.llenas),
          String(u.minimo),
        ]),
      },
    ],
  };
}

/** Una garrafa cuyo vendible no coincide con el físico. */
export interface DiferenciaDelCorreo {
  garrafa: string;
  vendible: number;
  esperado: number;
  llenas: number;
  reservadas: number;
  diferencia: number;
  /** Reservadas de más que el físico no cubre. */
  reservadasDeMas: number;
}

/** Aviso de la conciliación nocturna (D4) cuando el vendible no cierra con el físico. */
export function mensajeDeConciliacion(
  diferencias: readonly DiferenciaDelCorreo[],
  renglonesSinMovimiento: number,
): MensajeDeCorreo {
  const bloques: BloqueDeCorreo[] = [
    { tipo: 'parrafo', texto: 'El stock vendible no coincide con el físico:' },
    {
      tipo: 'tabla',
      columnas: [
        { titulo: 'Garrafa' },
        { titulo: 'Vendible', alinear: 'derecha', mono: true },
        { titulo: 'Esperado', alinear: 'derecha', mono: true },
        { titulo: 'Dif.', alinear: 'derecha', mono: true },
      ],
      filas: diferencias.map((d) => [
        d.garrafa,
        String(d.vendible),
        `${d.esperado} (${d.llenas} − ${d.reservadas})`,
        String(d.diferencia),
      ]),
    },
    {
      tipo: 'parrafo',
      suave: true,
      texto: 'Esperado = llenas − reservadas.',
    },
  ];
  for (const d of diferencias.filter((x) => x.reservadasDeMas > 0)) {
    bloques.push({
      tipo: 'nota',
      tono: 'peligro',
      titulo: d.garrafa,
      texto: `${d.reservadasDeMas} reservada(s) de más que el físico no cubre: hay que cancelar pedidos o reponer stock.`,
    });
  }
  if (renglonesSinMovimiento > 0) {
    bloques.push({
      tipo: 'nota',
      tono: 'aviso',
      texto: `${renglonesSinMovimiento} renglón(es) de pedidos entregados no descontaron el stock físico.`,
    });
  }
  return {
    asunto: 'Conciliación de stock: hay diferencias',
    preheader: `${diferencias.length} garrafa(s) con el vendible distinto del físico. No se corrigió nada: revisalo.`,
    etiqueta: 'Conciliación de stock',
    titulo: 'Hay diferencias en el stock',
    bloques,
  };
}
