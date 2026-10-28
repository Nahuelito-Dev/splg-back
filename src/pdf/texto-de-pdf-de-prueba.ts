import { inflateSync } from 'zlib';

/**
 * Texto de un PDF armado por pdfkit con fuentes estándar, para los tests: abre
 * los streams comprimidos y junta las cadenas hexadecimales de los operadores
 * `TJ`/`Tj`. Sirve para comprobar que un documento dice lo que tiene que decir,
 * no para leer PDF en general.
 */
export function textoDePdf(pdf: Buffer): string {
  const crudo = pdf.toString('latin1');
  const contenidos: string[] = [];
  const stream = /(?<!end)stream\n([\s\S]*?)\nendstream/g;
  for (const coincidencia of crudo.matchAll(stream)) {
    const bytes = Buffer.from(coincidencia[1], 'latin1');
    try {
      contenidos.push(inflateSync(bytes).toString('latin1'));
    } catch {
      contenidos.push(coincidencia[1]);
    }
  }
  const lineas: string[] = [];
  for (const contenido of contenidos) {
    for (const operador of contenido.matchAll(
      /\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g,
    )) {
      const hex = (operador[1] ?? `<${operador[2]}>`).matchAll(
        /<([0-9a-fA-F]*)>/g,
      );
      lineas.push(
        [...hex]
          .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
          .join(''),
      );
    }
  }
  return lineas.join('\n');
}
