/** PUERTO del reloj: el "ahora" contra el que se miden vigencias y fechas. */
export abstract class ClockPort {
  abstract ahora(): Date;
}
