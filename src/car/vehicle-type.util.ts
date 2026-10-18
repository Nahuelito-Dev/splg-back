/**
 * ¿El tipo de vehículo (`car.type_car`, texto libre que el panel ofrece como
 * "Moto", "Auto", "Camioneta"...) es una moto? Es la condición del despacho
 * express (CU-149). Ignora mayúsculas y tildes: "Moto", "moto", "Motocicleta".
 */
export function esMoto(typeCar: string | null | undefined): boolean {
  if (!typeCar) return false;
  return typeCar
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .includes('moto');
}
