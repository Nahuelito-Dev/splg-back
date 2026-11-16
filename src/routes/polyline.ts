export interface PuntoDeRuta {
  lat: number;
  lng: number;
}

/**
 * Decodifica una polilínea en el formato de Google (precisión 5), que también
 * habla OSRM con `geometries=polyline`.
 */
export function decodificarPolilinea(codificada: string): PuntoDeRuta[] {
  const puntos: PuntoDeRuta[] = [];
  let indice = 0;
  let lat = 0;
  let lng = 0;
  const siguiente = (): number => {
    let resultado = 0;
    let desplazamiento = 0;
    let byte: number;
    do {
      if (indice >= codificada.length) {
        throw new Error('Polilínea truncada');
      }
      byte = codificada.charCodeAt(indice++) - 63;
      resultado |= (byte & 0x1f) << desplazamiento;
      desplazamiento += 5;
    } while (byte >= 0x20);
    return resultado & 1 ? ~(resultado >> 1) : resultado >> 1;
  };
  while (indice < codificada.length) {
    lat += siguiente();
    lng += siguiente();
    puntos.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return puntos;
}

/** Codifica puntos en el formato de Google (precisión 5): la inversa de `decodificarPolilinea`. */
export function codificarPolilinea(puntos: readonly PuntoDeRuta[]): string {
  let salida = '';
  let latAnterior = 0;
  let lngAnterior = 0;
  const valor = (delta: number): string => {
    let v = delta < 0 ? ~(delta << 1) : delta << 1;
    let texto = '';
    while (v >= 0x20) {
      texto += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return texto + String.fromCharCode(v + 63);
  };
  for (const p of puntos) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    salida += valor(lat - latAnterior) + valor(lng - lngAnterior);
    latAnterior = lat;
    lngAnterior = lng;
  }
  return salida;
}
