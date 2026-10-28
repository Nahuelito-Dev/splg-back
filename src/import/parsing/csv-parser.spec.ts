import { decodificarCsv, detectarSeparador, parsearCsv } from './csv-parser';

describe('csv-parser', () => {
  describe('detectarSeparador', () => {
    it('elige ; cuando el encabezado trae más punto y coma que comas', () => {
      expect(
        detectarSeparador('Tipo;Peso (kg);Precio\n10 kg;10;12500,50'),
      ).toBe(';');
    });

    it('elige coma por defecto y cuando manda la coma', () => {
      expect(detectarSeparador('Tipo,Peso,Precio\n10 kg,10,12500.5')).toBe(',');
      expect(detectarSeparador('Tipo')).toBe(',');
    });

    it('ignora los separadores que están entre comillas', () => {
      expect(detectarSeparador('"a;b;c",d,e')).toBe(',');
    });
  });

  describe('parsearCsv', () => {
    it('lee con ; y coma decimal sin tocar el número', () => {
      expect(parsearCsv('Tipo;Precio\n10 kg;12500,50\n')).toEqual([
        ['Tipo', 'Precio'],
        ['10 kg', '12500,50'],
      ]);
    });

    it('lee con coma y saltos CRLF', () => {
      expect(parsearCsv('a,b\r\n1,2\r\n3,4')).toEqual([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
      ]);
    });

    it('respeta comillas, separadores adentro, comillas escapadas y saltos de línea en la celda', () => {
      expect(parsearCsv('a;b\n"x;y";"dijo ""hola""\nchau"')).toEqual([
        ['a', 'b'],
        ['x;y', 'dijo "hola"\nchau'],
      ]);
    });

    it('conserva las celdas vacías', () => {
      expect(parsearCsv('a;b;c\n1;;3')).toEqual([
        ['a', 'b', 'c'],
        ['1', '', '3'],
      ]);
    });

    it('un texto vacío no tiene filas', () => {
      expect(parsearCsv('')).toEqual([]);
    });
  });

  describe('decodificarCsv', () => {
    it('saca el BOM de UTF-8', () => {
      const buffer = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('Descripción', 'utf-8'),
      ]);
      expect(decodificarCsv(buffer)).toBe('Descripción');
    });

    it('lee UTF-8 sin BOM', () => {
      expect(decodificarCsv(Buffer.from('Razón social', 'utf-8'))).toBe(
        'Razón social',
      );
    });

    it('si no es UTF-8 válido lo lee como Windows-1252 (Excel)', () => {
      expect(decodificarCsv(Buffer.from('Razón', 'latin1'))).toBe('Razón');
    });
  });
});
