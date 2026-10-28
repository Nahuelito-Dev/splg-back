/**
 * ZIP mínimo para las pruebas: entradas sin comprimir y sin CRC válido (el
 * lector de `entradasDeZip` sólo mira el directorio central).
 */
export function zipDePrueba(nombres: string[], comentario = ''): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let posicion = 0;
  for (const nombre of nombres) {
    const n = Buffer.from(nombre, 'utf8');
    const local = Buffer.alloc(30 + n.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(n.length, 26);
    n.copy(local, 30);
    const central = Buffer.alloc(46 + n.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(posicion, 42);
    n.copy(central, 46);
    locales.push(local);
    centrales.push(central);
    posicion += local.length;
  }
  const directorio = Buffer.concat(centrales);
  const c = Buffer.from(comentario, 'utf8');
  const fin = Buffer.alloc(22 + c.length);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(nombres.length, 8);
  fin.writeUInt16LE(nombres.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(posicion, 16);
  fin.writeUInt16LE(c.length, 20);
  c.copy(fin, 22);
  return Buffer.concat([...locales, directorio, fin]);
}
