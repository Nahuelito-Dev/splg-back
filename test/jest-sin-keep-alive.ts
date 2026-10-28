import { Agent, globalAgent } from 'http';

/**
 * Desde Node 19 el agente HTTP global reutiliza conexiones. En los tests por
 * HTTP, supertest reusaba un socket que el servidor de la prueba ya había
 * cerrado por inactividad y, con la suite en paralelo, fallaba al azar con
 * «socket hang up» o «Parse Error». En los tests, una conexión por pedido.
 */
// `keepAlive` existe en el agente pero los tipos de Node no lo declaran.
(globalAgent as Agent & { keepAlive: boolean }).keepAlive = false;
