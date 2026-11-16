/**
 * Lector de CSV tolerante: separador `;` o `,` (se detecta por el encabezado),
 * comillas con `""` escapado, saltos `\n` o `\r\n`, UTF-8 con o sin BOM (y si el
 * archivo no es UTF-8 válido, Windows-1252, que es lo que guarda Excel).
 */

export function decodificarCsv(buffer: Buffer): string {
  const sinBom =
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(sinBom);
  } catch {
    return new TextDecoder('windows-1252').decode(sinBom);
  }
}

/** `;` si el encabezado trae más punto y coma que comas; si no, coma. */
export function detectarSeparador(texto: string): ',' | ';' {
  let comillas = false;
  let comas = 0;
  let puntoYComas = 0;
  for (const c of texto) {
    if (c === '"') comillas = !comillas;
    else if (!comillas && (c === '\n' || c === '\r')) break;
    else if (!comillas && c === ',') comas++;
    else if (!comillas && c === ';') puntoYComas++;
  }
  return puntoYComas > comas ? ';' : ',';
}

export function parsearCsv(texto: string): string[][] {
  const separador = detectarSeparador(texto);
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          celda += '"';
          i++;
        } else {
          comillas = false;
        }
      } else {
        celda += c;
      }
    } else if (c === '"') {
      comillas = true;
    } else if (c === separador) {
      fila.push(celda);
      celda = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
    } else {
      celda += c;
    }
  }
  if (celda !== '' || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas;
}
