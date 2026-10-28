import PDFDocument from 'pdfkit';
import { acotar, aWinAnsi, fechaHora } from './pdf-formato';

/** Datos del membrete: salen de la distribuidora del documento. */
export interface Membrete {
  nombre: string;
  razonSocial: string | null;
  cuit: string | null;
  contacto: string | null;
  /** PNG o JPEG listo para incrustar; `null` si no tiene logo o no se pudo leer. */
  logo: Buffer | null;
}

export type Alineacion = 'left' | 'right' | 'center';

export interface Columna {
  titulo: string;
  /** Peso relativo del ancho de la columna. */
  peso: number;
  alinear?: Alineacion;
}

export interface LineaDeTotal {
  etiqueta: string;
  valor: string;
  destacada?: boolean;
}

export interface EncabezadoDeDocumento {
  /** `REMITO`, `RECIBO`... */
  tipo: string;
  /** `N° 0012`, el código del pedido, el período. */
  referencia: string;
  subtitulo?: string;
}

const TINTA = '#1D2939';
const APAGADO = '#667085';
const LINEA = '#D0D5DD';
const ZEBRA = '#F5F6F8';
const ACENTO = '#D9530E';

const MARGEN = 40;
const ALTO_FILA_MIN = 18;
/** Topes de largo: un texto enorme (una nota pegada entera) no puede desarmar la página. */
const MAXIMO_VALOR = 300;
const MAXIMO_CELDA = 200;

/**
 * Arma un PDF A4 con el membrete de la distribuidora, secciones, tablas con
 * salto de página y pie numerado. Usa las fuentes estándar de PDF (Helvetica),
 * que cubren el castellano completo.
 */
export class PdfBuilder {
  private readonly doc: PDFKit.PDFDocument;
  private readonly fragmentos: Buffer[] = [];
  private readonly terminado: Promise<Buffer>;

  constructor(
    titulo: string,
    private readonly membrete: Membrete,
    private readonly encabezado: EncabezadoDeDocumento,
  ) {
    this.doc = new PDFDocument({
      size: 'A4',
      margin: MARGEN,
      bufferPages: true,
      info: { Title: titulo, Author: membrete.nombre, Creator: 'SPLG' },
    });
    this.terminado = new Promise<Buffer>((resolver, rechazar) => {
      this.doc.on('data', (parte: Buffer) => this.fragmentos.push(parte));
      this.doc.on('end', () => resolver(Buffer.concat(this.fragmentos)));
      this.doc.on('error', rechazar);
    });
    this.dibujarEncabezado();
  }

  private get ancho(): number {
    return this.doc.page.width - MARGEN * 2;
  }

  private get limiteInferior(): number {
    return this.doc.page.height - MARGEN - 20;
  }

  private dibujarEncabezado(): void {
    const { doc, membrete, encabezado } = this;
    const y0 = MARGEN;
    let xTexto = MARGEN;
    if (membrete.logo) {
      try {
        doc.image(membrete.logo, MARGEN, y0, { fit: [90, 56] });
        xTexto = MARGEN + 100;
      } catch {
        // Un logo que pdfkit no puede leer no tira abajo el documento.
        xTexto = MARGEN;
      }
    }
    const anchoDer = 190;
    const anchoIzq = this.ancho - anchoDer - (xTexto - MARGEN) - 10;

    doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(14);
    doc.text(aWinAnsi(membrete.nombre), xTexto, y0, { width: anchoIzq });
    doc.font('Helvetica').fontSize(8.5).fillColor(APAGADO);
    const lineas = [
      membrete.razonSocial,
      membrete.cuit ? `CUIT ${membrete.cuit}` : null,
      membrete.contacto,
    ].filter((l): l is string => Boolean(l));
    for (const l of lineas)
      doc.text(aWinAnsi(l), xTexto, doc.y, { width: anchoIzq });
    const yIzq = doc.y;

    const xDer = MARGEN + this.ancho - anchoDer;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(ACENTO);
    doc.text(aWinAnsi(encabezado.tipo), xDer, y0, {
      width: anchoDer,
      align: 'right',
    });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(TINTA);
    doc.text(aWinAnsi(encabezado.referencia), xDer, doc.y, {
      width: anchoDer,
      align: 'right',
    });
    if (encabezado.subtitulo) {
      doc.font('Helvetica').fontSize(8.5).fillColor(APAGADO);
      doc.text(aWinAnsi(encabezado.subtitulo), xDer, doc.y, {
        width: anchoDer,
        align: 'right',
      });
    }
    const yFin = Math.max(yIzq, doc.y, y0 + (membrete.logo ? 60 : 0)) + 8;
    doc
      .moveTo(MARGEN, yFin)
      .lineTo(MARGEN + this.ancho, yFin)
      .lineWidth(1.2)
      .strokeColor(ACENTO)
      .stroke();
    doc.x = MARGEN;
    doc.y = yFin + 12;
  }

  private asegurarEspacio(alto: number, alSaltar?: () => void): void {
    if (this.doc.y + alto <= this.limiteInferior) return;
    this.doc.addPage();
    this.doc.x = MARGEN;
    this.doc.y = MARGEN;
    alSaltar?.();
  }

  seccion(titulo: string): this {
    // El título más la cabecera y las primeras filas de lo que sigue: un título no queda solo al pie.
    this.asegurarEspacio(40 + ALTO_FILA_MIN * 3);
    this.doc.moveDown(0.4);
    this.doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(ACENTO)
      .text(aWinAnsi(titulo.toUpperCase()), MARGEN, this.doc.y, {
        width: this.ancho,
      });
    this.doc.moveDown(0.25);
    return this;
  }

  /** Pares etiqueta / valor en `columnas` columnas. */
  datos(pares: ReadonlyArray<readonly [string, string]>, columnas = 2): this {
    const ancho = this.ancho / columnas;
    for (let i = 0; i < pares.length; i += columnas) {
      const fila = pares
        .slice(i, i + columnas)
        .map(
          ([etiqueta, valor]) =>
            [
              acotar(etiqueta.toUpperCase(), 60),
              acotar(valor || '-', MAXIMO_VALOR),
            ] as const,
        );
      // Se mide antes de reservar: un valor de varias líneas no puede quedar partido entre dos páginas.
      this.doc.font('Helvetica').fontSize(9.5);
      const altoDeValores = Math.max(
        ...fila.map(([, valor]) =>
          this.doc.heightOfString(valor, { width: ancho - 8 }),
        ),
      );
      this.asegurarEspacio(altoDeValores + 16);
      const y = this.doc.y;
      let alto = 0;
      fila.forEach(([etiqueta, valor], c) => {
        const x = MARGEN + c * ancho;
        this.doc.font('Helvetica').fontSize(7.5).fillColor(APAGADO);
        this.doc.text(etiqueta, x, y, { width: ancho - 8 });
        this.doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
        this.doc.text(valor, x, this.doc.y, { width: ancho - 8 });
        alto = Math.max(alto, this.doc.y - y);
      });
      this.doc.x = MARGEN;
      this.doc.y = y + alto + 6;
    }
    return this;
  }

  texto(contenido: string, opciones?: { apagado?: boolean }): this {
    this.asegurarEspacio(20);
    this.doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(opciones?.apagado ? APAGADO : TINTA)
      .text(aWinAnsi(contenido), MARGEN, this.doc.y, { width: this.ancho });
    this.doc.moveDown(0.3);
    return this;
  }

  tabla(
    columnas: readonly Columna[],
    filas: ReadonlyArray<readonly string[]>,
    vacio = 'Sin registros.',
  ): this {
    const sumaPesos = columnas.reduce((a, c) => a + c.peso, 0);
    const anchos = columnas.map((c) => (c.peso / sumaPesos) * this.ancho);
    const xs = anchos.map((_, i) =>
      anchos.slice(0, i).reduce((a, b) => a + b, MARGEN),
    );

    const cabecera = () => {
      const y = this.doc.y;
      this.doc.rect(MARGEN, y, this.ancho, ALTO_FILA_MIN).fill(TINTA);
      this.doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
      columnas.forEach((c, i) => {
        this.doc.text(aWinAnsi(c.titulo), xs[i] + 4, y + 5, {
          width: anchos[i] - 8,
          align: c.alinear ?? 'left',
          lineBreak: false,
        });
      });
      this.doc.x = MARGEN;
      this.doc.y = y + ALTO_FILA_MIN;
    };

    this.asegurarEspacio(ALTO_FILA_MIN * 3);
    cabecera();
    if (filas.length === 0) {
      this.doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(APAGADO)
        .text(aWinAnsi(vacio), MARGEN + 4, this.doc.y + 5, {
          width: this.ancho - 8,
        });
      this.doc.y += 8;
      return this;
    }

    filas.forEach((original, n) => {
      const fila = original.map((celda) => acotar(celda, MAXIMO_CELDA));
      this.doc.font('Helvetica').fontSize(8.5);
      const alto = Math.max(
        ALTO_FILA_MIN,
        ...fila.map(
          (celda, i) =>
            this.doc.heightOfString(celda, { width: anchos[i] - 8 }) + 9,
        ),
      );
      this.asegurarEspacio(alto, cabecera);
      const y = this.doc.y;
      if (n % 2 === 1) this.doc.rect(MARGEN, y, this.ancho, alto).fill(ZEBRA);
      // La cabecera repetida tras un salto deja la fuente en negrita: se vuelve a la de la fila medida.
      this.doc.font('Helvetica').fontSize(8.5).fillColor(TINTA);
      fila.forEach((celda, i) => {
        this.doc.text(celda, xs[i] + 4, y + 5, {
          width: anchos[i] - 8,
          align: columnas[i].alinear ?? 'left',
        });
      });
      this.doc
        .moveTo(MARGEN, y + alto)
        .lineTo(MARGEN + this.ancho, y + alto)
        .lineWidth(0.4)
        .strokeColor(LINEA)
        .stroke();
      this.doc.x = MARGEN;
      this.doc.y = y + alto;
    });
    this.doc.moveDown(0.5);
    return this;
  }

  /** Bloque de totales alineado a la derecha. */
  totales(lineas: readonly LineaDeTotal[]): this {
    const anchoBloque = 280;
    const anchoEtiqueta = 170;
    const x = MARGEN + this.ancho - anchoBloque;
    this.asegurarEspacio(lineas.length * 20 + 10);
    for (const l of lineas) {
      const y = this.doc.y;
      if (l.destacada) {
        this.doc.rect(x, y - 2, anchoBloque, 20).fill(ACENTO);
        this.doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF');
      } else {
        this.doc.font('Helvetica').fontSize(9.5).fillColor(TINTA);
      }
      this.doc.text(aWinAnsi(l.etiqueta), x + 6, y + 2, {
        width: anchoEtiqueta - 6,
        height: 14,
        ellipsis: true,
      });
      this.doc.text(aWinAnsi(l.valor), x + anchoEtiqueta, y + 2, {
        width: anchoBloque - anchoEtiqueta - 6,
        height: 14,
        align: 'right',
        lineBreak: false,
      });
      this.doc.x = MARGEN;
      this.doc.y = y + 20;
    }
    this.doc.moveDown(0.3);
    return this;
  }

  /** Cierra el documento: pie con numeración en cada página y devuelve los bytes. */
  async finalizar(): Promise<Buffer> {
    const { doc } = this;
    const rango = doc.bufferedPageRange();
    const generado = `${this.membrete.nombre} · Generado el ${fechaHora(new Date())}`;
    for (let i = 0; i < rango.count; i++) {
      doc.switchToPage(rango.start + i);
      // Sin margen inferior, escribir en el pie no dispara una página nueva.
      const margenInferior = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - MARGEN + 4;
      doc
        .moveTo(MARGEN, y - 6)
        .lineTo(MARGEN + this.ancho, y - 6)
        .lineWidth(0.4)
        .strokeColor(LINEA)
        .stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(APAGADO);
      doc.text(aWinAnsi(generado), MARGEN, y, {
        width: this.ancho * 0.7,
        lineBreak: false,
      });
      doc.text(aWinAnsi(`Página ${i + 1} de ${rango.count}`), MARGEN, y, {
        width: this.ancho,
        align: 'right',
        lineBreak: false,
      });
      doc.page.margins.bottom = margenInferior;
    }
    doc.end();
    return this.terminado;
  }
}
