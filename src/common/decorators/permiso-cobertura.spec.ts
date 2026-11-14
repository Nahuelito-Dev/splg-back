import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { PERMISOS } from '../permisos/catalogo';

const RAIZ_SRC = join(process.cwd(), 'src');

const EXENTOS: Readonly<Record<string, string>> = {
  'admin/permissions.controller.ts#PermissionsController.findAll':
    'El catálogo es necesario para que cualquier admin pueda armar el menú.',
  'admin/permissions.controller.ts#MyPermissionsController.mine':
    'Los permisos efectivos son necesarios para que cualquier admin pueda armar el menú.',
  'admin-notifications/admin-notifications.controller.ts#AdminNotificationsController.listar':
    'La campana de avisos está en todas las pantallas del panel: la usa cualquier admin.',
  'admin-notifications/admin-notifications.controller.ts#AdminNotificationsController.contarSinLeer':
    'La campana de avisos está en todas las pantallas del panel: la usa cualquier admin.',
  'admin-notifications/admin-notifications.controller.ts#AdminNotificationsController.marcarLeido':
    'Marcar como leído un aviso propio no depende de ningún módulo.',
  'admin-notifications/admin-notifications.controller.ts#AdminNotificationsController.marcarTodosLeidos':
    'Marcar como leído un aviso propio no depende de ningún módulo.',
  'platform/modules/company-modules.controller.ts#CompanyModulesController.list':
    'Los módulos de su empresa: cualquier administrador los ve (DISENO-PLATAFORMA-ORIXTECH §5.3); con eso el panel arma el menú',
  'platform/modules/company-modules.controller.ts#MeFeaturesController.features':
    'Qué módulos están en uso en la distribuidora de la sesión: lo leen el panel y las apps al iniciar (§5.3)',
  'distributor/distributor.controller.ts#DistributorController.findCurrent':
    'La cabecera del panel muestra la distribuidora del admin en todas las pantallas.',
};

function decoradores(nodo: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(nodo) ? (ts.getDecorators(nodo) ?? []) : [];
}

function nombreDelDecorador(decorador: ts.Decorator): string | undefined {
  const expresion = decorador.expression;
  return ts.isCallExpression(expresion) && ts.isIdentifier(expresion.expression)
    ? expresion.expression.text
    : undefined;
}

function incluyeAdmin(decoradoresDelNodo: readonly ts.Decorator[]): boolean {
  return decoradoresDelNodo.some(
    (decorador) =>
      nombreDelDecorador(decorador) === 'Auth' &&
      decorador.getText().includes('RoleType.ADMIN'),
  );
}

function esEndpoint(decoradoresDelNodo: readonly ts.Decorator[]): boolean {
  return decoradoresDelNodo.some((decorador) =>
    ['Get', 'Post', 'Put', 'Patch', 'Delete'].includes(
      nombreDelDecorador(decorador) ?? '',
    ),
  );
}

function permisosDeclarados(
  decoradoresDelNodo: readonly ts.Decorator[],
): string[] {
  return decoradoresDelNodo.flatMap((decorador) => {
    if (nombreDelDecorador(decorador) !== 'Permiso') return [];
    const expresion = decorador.expression;
    if (!ts.isCallExpression(expresion)) return [];
    return expresion.arguments.map((argumento) =>
      argumento.getText().slice(1, -1),
    );
  });
}

function archivosDeControladores(directorio: string): string[] {
  return readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = join(directorio, entrada.name);
    if (entrada.isDirectory()) return archivosDeControladores(ruta);
    return entrada.name.endsWith('.controller.ts') ? [ruta] : [];
  });
}

describe('cobertura de @Permiso en controladores del panel', () => {
  it('declara un permiso válido en todo endpoint que admite admin', () => {
    const faltantes: string[] = [];
    const invalidos: string[] = [];

    for (const archivo of archivosDeControladores(RAIZ_SRC)) {
      const texto = readFileSync(archivo, 'utf8');
      const fuente = ts.createSourceFile(
        archivo,
        texto,
        ts.ScriptTarget.Latest,
        true,
      );
      const rutaRelativa = relative(RAIZ_SRC, archivo);

      for (const clase of fuente.statements.filter(ts.isClassDeclaration)) {
        const permisoDeClase = permisosDeclarados(decoradores(clase));
        const adminDeClase = incluyeAdmin(decoradores(clase));

        for (const metodo of clase.members.filter(ts.isMethodDeclaration)) {
          const decoradoresDelMetodo = decoradores(metodo);
          if (!esEndpoint(decoradoresDelMetodo)) continue;

          const clave = `${rutaRelativa}#${clase.name?.text ?? '<anónima>'}.${metodo.name.getText()}`;
          const permisos = [
            ...permisoDeClase,
            ...permisosDeclarados(decoradoresDelMetodo),
          ];
          if (
            (adminDeClase || incluyeAdmin(decoradoresDelMetodo)) &&
            permisos.length === 0 &&
            !EXENTOS[clave]
          ) {
            faltantes.push(clave);
          }
          invalidos.push(
            ...permisos
              .filter(
                (permiso) =>
                  !PERMISOS.includes(permiso as (typeof PERMISOS)[number]),
              )
              .map((permiso) => `${clave}: ${permiso}`),
          );
        }
      }
    }

    expect(faltantes).toEqual([]);
    expect(invalidos).toEqual([]);
  });
});
