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
