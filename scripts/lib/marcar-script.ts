import { basename, extname } from 'path';

/**
 * Importar primero (antes de `AppModule`): le pone a la conexión del script el
 * nombre `splg-script:<archivo>` en `application_name`, para que lo que escriba
 * quede en la auditoría como cambio directo y no como obra de la API.
 */
const archivo = process.argv[1] ?? 'script';
process.env.DB_APP_NAME ??= `splg-script:${basename(archivo, extname(archivo))}`;
