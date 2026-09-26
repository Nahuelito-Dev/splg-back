"""Barrido de aislamiento entre distribuidoras (H-77 a H-84).

Cada actor de la distribuidora A (admin, chofer, cliente, y el super admin
"viendo como" A) contra cada recurso de la distribuidora B. Lo ajeno responde
404 (o 403 donde la regla es de rol); en los listados, 200 sin ningún id de B.
Uso: run.sh <salida>. Ver LEEME.md.
"""
import json, sys, time, urllib.request, os
API = os.environ.get('SPLG_API', 'http://localhost:3100/api')
CLAVE = os.environ['SPLG_CLAVE']  # la de los usuarios de prueba; no se versiona
CUENTAS = {
  'admA': 'admin@splg.com', 'choA': 'qa.chofer.172240@splg-test.com', 'cliA': 'qa.cliente.172240@splg-test.com',
  'supA': 'superadmin@splg.com',  # con X-Distributor A: el super admin "viendo como"
  'admB': 'adminb.7886@splg-test.com', 'choB': 'reg19.7886@splg-test.com', 'cliB': 'qa.cliente.1790169242@splg-test.com',
}
def login(email):
    req = urllib.request.Request(API + '/auth/login', method='POST', headers={'Content-Type': 'application/json'},
                                 data=json.dumps({'email': email, 'password': CLAVE}).encode())
    with urllib.request.urlopen(req) as r: return json.load(r)['accessToken']
# Un token dura una hora y el acceso admite 8 ingresos por minuto por cuenta:
# se reutilizan entre corridas mientras tengan menos de 50 minutos.
CACHE = os.path.join(os.environ.get('SPLG_TMP', '/tmp/splg-alineacion'), 'tokens-aislamiento.json')
try:
    guardados = json.load(open(CACHE))
    if time.time() - guardados['cuando'] > 50 * 60: raise ValueError('vencidos')
    ACT = guardados['tokens']
except (OSError, ValueError, KeyError):
    ACT = {k: login(v) for k, v in CUENTAS.items()}
    json.dump({'cuando': time.time(), 'tokens': ACT}, open(CACHE, 'w'))
b = lambda n: f'bbbb0000-0000-4000-8000-{n:012x}'
B = dict(slot=b(1), zona=b(2), gas=b(3), car=b(4), ordEnt=b(5), ordPen=b(6), cyl=b(9), claim=b(11), inc=b(12), rating=b(13),
         dlv='de19bd70-c58d-4823-a409-c077cd7be352', choUser='a29dc060-6efc-4fe3-9f21-8bef5643eb26',
         cliUser='6addc762-49c9-4262-8e82-aca374604acf', cli='9f775e35-45f7-493a-9916-4b9b5eaca4de',
         dist='5bb47681-f5a0-4cd9-ada2-5f08e5e0e41c', admB_email='adminb.7886@splg-test.com')
B['addr'] = sys.argv[1] if len(sys.argv) > 1 else ''
A_DIST = 'af0c1b75-8090-42ed-bea9-7a043adc61cd'
A_CYL = 'bbbb0000-0000-4000-8000-0000000000a1'  # envase lleno de A (fixture-b.sql)

def call(actor, method, path, body=None):
    h = {'Authorization': f'Bearer {ACT[actor]}', 'Content-Type': 'application/json'}
    h['X-Client-Source'] = {'adm':'panel-app','sup':'panel-app','cho':'driver-app','cli':'customer-app'}[actor[:3]]
    if actor == 'supA': h['X-Distributor'] = A_DIST
    req = urllib.request.Request(API + path, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()

CASOS = []
def c(actor, m, p, body=None, esperado=(404,), nota=''): CASOS.append((actor, m, p, body, esperado, nota))
LISTA = 'lista'  # 200 y sin ids de B en el cuerpo

for adm in ('admA', 'supA'):
    # car
    c(adm,'GET','/car',esperado=LISTA); c(adm,'GET',f'/car/{B["car"]}'); c(adm,'GET',f'/car/user/{B["choUser"]}',esperado=LISTA,nota='acotado: lista vacía')
    c(adm,'GET','/car/patent/BBB999',esperado=(200,),nota='acotado: null'); c(adm,'PATCH',f'/car/{B["car"]}',{'car_color':'verde'})
    c(adm,'POST','/car',{'user_id':B['choUser'],'type_car':'x','car_capacity':1,'car_patent':'ZZZ111','car_brand':'x','car_model':'x','car_year':2020,'car_color':'x'},esperado=(404,400,403))
    # claims
    c(adm,'GET','/claims',esperado=LISTA); c(adm,'PATCH',f'/claims/{B["claim"]}/resolve',{'status':'resolved','resolution':'x'})
    c(adm,'POST','/claims',{'orderId':B['ordEnt'],'customerId':B['cliUser'],'reason':'x','description':'x'},esperado=(404,400,403))
    # coverage
    c(adm,'GET','/coverage-zones',esperado=LISTA); c(adm,'GET',f'/coverage-zones/{B["zona"]}')
    c(adm,'PATCH',f'/coverage-zones/{B["zona"]}',{'priority':9}); c(adm,'DELETE',f'/coverage-zones/{B["zona"]}')
    # customers (compartidos: A no ve los que no le compraron)
    c(adm,'GET','/customers',esperado=LISTA); c(adm,'GET',f'/customers/{B["cli"]}'); c(adm,'GET',f'/customers/user/{B["cliUser"]}')
    c(adm,'PATCH',f'/customers/{B["cli"]}',{'notification_token':'x'},esperado=(404,403))
    c(adm,'PATCH',f'/customers/{B["cli"]}/location',{'latLng':'-27.4,-55.9'},esperado=(404,403))
    c(adm,'DELETE',f'/customers/{B["cli"]}',esperado=(404,403))
    # cylinders
    c(adm,'GET','/cylinders',esperado=LISTA); c(adm,'GET',f'/cylinders/{B["cyl"]}'); c(adm,'GET',f'/cylinders/{B["cyl"]}/history')
    c(adm,'PATCH',f'/cylinders/{B["cyl"]}/transition',{'toState':'filled'}); c(adm,'POST','/cylinders/assign',{'serials':['SER-B-0001'],'orderId':B['ordPen']},esperado=(404,400))
    # H-90: un envase propio no se cuelga de un pedido de B
    c(adm,'POST','/cylinders/assign',{'serials':['SER-A-AIS-1'],'orderId':B['ordPen']},nota='H-90')
    c(adm,'PATCH',f'/cylinders/{A_CYL}/transition',{'toState':'dispatched','orderId':B['ordPen']},nota='H-90')
    # delivery
    c(adm,'GET','/delivery',esperado=LISTA); c(adm,'GET','/delivery/active',esperado=LISTA); c(adm,'GET',f'/delivery/{B["dlv"]}')
    c(adm,'GET',f'/delivery/user/{B["choUser"]}'); c(adm,'PATCH',f'/delivery/{B["dlv"]}',{'validated':True})
    for s in ('validate','invalidate','status'): c(adm,'PATCH',f'/delivery/{B["dlv"]}/{s}',{'isActive':True} if s=='status' else None)
    c(adm,'PATCH',f'/delivery/{B["dlv"]}/location',{'latLng':'-27.4,-55.9'}); c(adm,'PATCH',f'/delivery/{B["dlv"]}/balance',{'amount':1})
    c(adm,'PATCH',f'/delivery/user/{B["choUser"]}/availability',{'available':True}); c(adm,'DELETE',f'/delivery/{B["dlv"]}')
    # gascylinder
    c(adm,'GET',f'/gascylinder/{B["gas"]}',esperado=(200,),nota='catálogo público'); c(adm,'GET','/gascylinder/type/B-10kg',esperado=(404,)); c(adm,'PATCH',f'/gascylinder/{B["gas"]}',{'price':1})
    c(adm,'PATCH',f'/gascylinder/{B["gas"]}/stock',{'quantity':1}); c(adm,'DELETE',f'/gascylinder/{B["gas"]}')
    # incidents
    c(adm,'GET','/incidents',esperado=LISTA); c(adm,'GET',f'/incidents/order/{B["ordEnt"]}'); c(adm,'PATCH',f'/incidents/{B["inc"]}/resolve',{'resolutionNote':'x'})
    c(adm,'POST','/incidents',{'orderId':B['ordEnt'],'type':'other','description':'x'},esperado=(404,400))
    # notifications
    c(adm,'GET',f'/notifications/user/{B["choUser"]}',esperado=(403,) if adm=='admA' else (200,))
    c(adm,'POST','/notifications/order-confirmation',{'orderId':B['ordEnt'],'customerId':B['cliUser']},esperado=(403,) if adm=='admA' else (201,))
    c(adm,'POST','/notifications/send-test',{'token':'x','title':'x','body':'x'},esperado=(403,) if adm=='admA' else (201,))
    # orders
    c(adm,'GET','/orders',esperado=LISTA); c(adm,'GET',f'/orders/{B["ordEnt"]}'); c(adm,'GET',f'/orders/customer/{B["cliUser"]}',esperado=LISTA)
    c(adm,'GET',f'/orders/delivery/{B["dlv"]}',esperado=(404,'lista')); c(adm,'GET','/orders/available',esperado=LISTA); c(adm,'GET','/orders/reservations',esperado=LISTA)
    c(adm,'GET','/orders/stats/summary',esperado=LISTA); c(adm,'GET','/orders/stats/chart',esperado=LISTA)
    c(adm,'PATCH',f'/orders/{B["ordPen"]}/status',{'status':'accepted','deliveryId':B['dlv']}); c(adm,'GET',f'/orders/{B["ordEnt"]}/delivery-code')
    c(adm,'POST',f'/orders/{B["ordPen"]}/confirm-delivery',{'code':'4321'}); c(adm,'PATCH',f'/orders/{B["ordPen"]}/assign/{B["dlv"]}')
    c(adm,'PATCH',f'/orders/{B["ordPen"]}/cancel',{'reason':'x'}); c(adm,'PATCH',f'/orders/{B["ordPen"]}/arrived')
    c(adm,'PATCH',f'/orders/{B["ordPen"]}/confirm-deposit'); c(adm,'DELETE',f'/orders/{B["ordPen"]}')
    # ratings
    c(adm,'GET',f'/ratings/user/{B["choUser"]}',esperado=(404,'lista')); c(adm,'GET',f'/ratings/user/{B["choUser"]}/summary',esperado=(404,'lista'))
    # reports
    for r in ('sales-by-driver','sales-by-product','sales-by-payment','sales-evolution'): c(adm,'GET',f'/reports/{r}',esperado=LISTA)
    # time-slot
    c(adm,'GET','/time-slot',esperado=LISTA); c(adm,'GET',f'/time-slot/{B["slot"]}'); c(adm,'DELETE',f'/time-slot/{B["slot"]}')
    # users / admin
    c(adm,'GET','/admin',esperado=LISTA); c(adm,'GET',f'/admin/term/{B["admB_email"]}')
    c(adm,'GET',f'/users/email/{B["admB_email"]}'); c(adm,'GET',f'/users/{B["choUser"]}')
    # user-address del cliente de B
    c(adm,'GET',f'/user-address/user/{B["cliUser"]}',esperado=(404,403)); c(adm,'GET',f'/user-address/{B["addr"]}',esperado=(404,403))
    # distribuidora B (sólo super admin)
    c(adm,'GET',f'/distributor/{B["dist"]}',esperado=(403,) if adm=='admA' else (200,404))

# chofer de A contra lo de B
for a in ('choA',):
    c(a,'GET',f'/cylinders/{B["cyl"]}'); c(a,'PATCH',f'/cylinders/{B["cyl"]}/transition',{'toState':'filled'})
    c(a,'POST','/cylinders/assign',{'serials':['SER-B-0001'],'orderId':B['ordPen']},esperado=(404,400))
    c(a,'POST','/cylinders/assign',{'serials':['SER-A-AIS-1'],'orderId':B['ordPen']},nota='H-90')
    c(a,'GET',f'/delivery/{B["dlv"]}',esperado=(404,403)); c(a,'GET',f'/delivery/user/{B["choUser"]}',esperado=(404,403))
    c(a,'PATCH',f'/delivery/{B["dlv"]}/location',{'latLng':'-27.4,-55.9'},esperado=(404,403))
    c(a,'PATCH',f'/delivery/user/{B["choUser"]}/availability',{'available':True},esperado=(404,403))
    c(a,'POST','/incidents',{'orderId':B['ordEnt'],'type':'other','description':'x'},esperado=(404,403))
    c(a,'GET',f'/incidents/order/{B["ordEnt"]}',esperado=(404,403))
    c(a,'GET',f'/orders/{B["ordEnt"]}',esperado=(404,403)); c(a,'GET',f'/orders/customer/{B["cliUser"]}',esperado=(404,403,'lista'))
    c(a,'GET',f'/orders/delivery/{B["dlv"]}',esperado=(404,403)); c(a,'GET','/orders/available',esperado=LISTA)
    c(a,'PATCH',f'/orders/{B["ordPen"]}/status',{'status':'accepted'},esperado=(404,403)); c(a,'POST',f'/orders/{B["ordPen"]}/reject',{'reason':'x'},esperado=(404,403))
    c(a,'GET',f'/orders/{B["ordEnt"]}/delivery-code',esperado=(404,403)); c(a,'PATCH',f'/orders/{B["ordPen"]}/location',{'lat':-27.4,'lng':-55.9},esperado=(404,403))
    c(a,'PATCH',f'/orders/{B["ordPen"]}/cancel',{'reason':'x'},esperado=(404,403)); c(a,'PATCH',f'/orders/{B["ordPen"]}/arrived',esperado=(404,403))
    c(a,'POST','/ratings',{'orderId':B['ordEnt'],'stars':5},esperado=(404,403,400))
    c(a,'GET',f'/ratings/user/{B["choUser"]}/summary',esperado=(404,403,200))
    c(a,'GET',f'/users/{B["choUser"]}',esperado=(404,403)); c(a,'GET',f'/car/user/{B["choUser"]}',esperado=(403,))
    c(a,'GET',f'/notifications/user/{B["choUser"]}',esperado=(404,403))

# cliente de A contra lo del cliente de B
for a in ('cliA',):
    c(a,'GET',f'/orders/{B["ordEnt"]}',esperado=(404,403)); c(a,'GET',f'/orders/customer/{B["cliUser"]}',esperado=(404,403))
    c(a,'POST',f'/orders/{B["ordPen"]}/confirm-delivery',{'code':'4321'},esperado=(404,403))
    c(a,'PATCH',f'/orders/{B["ordPen"]}/cancel',{'reason':'x'},esperado=(404,403))
    c(a,'POST','/claims',{'orderId':B['ordEnt'],'customerId':B['cliUser'],'reason':'x','description':'x'},esperado=(404,403,400))
    c(a,'POST','/ratings',{'orderId':B['ordEnt'],'stars':5},esperado=(404,403,400))
    c(a,'GET',f'/customers/{B["cli"]}',esperado=(404,403)); c(a,'GET',f'/customers/user/{B["cliUser"]}',esperado=(404,403))
    c(a,'PATCH',f'/customers/{B["cli"]}',{'lat_lang':'-27.4,-55.9'},esperado=(404,403)); c(a,'PATCH',f'/customers/{B["cli"]}/location',{'latLng':'-27.4,-55.9'},esperado=(404,403))
    c(a,'GET',f'/user-address/user/{B["cliUser"]}',esperado=(404,403)); c(a,'GET',f'/user-address/{B["addr"]}',esperado=(404,403))
    c(a,'GET',f'/user-address/user/{B["cliUser"]}/default',esperado=(404,403))
    c(a,'PATCH',f'/user-address/{B["addr"]}',{'street':'x'},esperado=(404,403)); c(a,'PATCH',f'/user-address/{B["addr"]}/set-default',esperado=(404,403))
    c(a,'DELETE',f'/user-address/{B["addr"]}',esperado=(404,403))
    c(a,'GET',f'/users/{B["cliUser"]}',esperado=(404,403)); c(a,'PATCH',f'/users/{B["cliUser"]}',{'full_name':'Otro nombre'},esperado=(404,403))
    c(a,'GET',f'/ratings/user/{B["choUser"]}/summary',esperado=(404,403,200))
    c(a,'GET',f'/notifications/user/{B["cliUser"]}',esperado=(404,403))
    c(a,'GET',f'/time-slot/{B["slot"]}',esperado=(200,404),nota='franja pública: el cliente elige distribuidora')

BIDS = [v for k, v in B.items() if k not in ('admB_email',) and v]
SOLO = sys.argv[2] if len(sys.argv) > 2 else None
def peso(cs):
    m, p = cs[1], cs[2]
    if m == 'GET': return 0
    if m == 'DELETE' or p.endswith(('/cancel', '/reject', '/confirm-delivery')): return 2
    return 1
CASOS = sorted([cs for cs in CASOS if not SOLO or cs[0] == SOLO], key=peso)
fallas = 0
for actor, m, p, body, esp, nota in CASOS:
    st, txt = call(actor, m, p, body)
    if esp == LISTA or (isinstance(esp, tuple) and 'lista' in esp and st == 200):
        fuga = [k for k, v in B.items() if v and k != 'admB_email' and v in txt]
        ok = st == 200 and not fuga
        det = f'fuga:{fuga}' if fuga else ''
    else:
        ok = st in esp; det = ''
    if not ok: fallas += 1
    print(f"{'ok ' if ok else 'XX '} {actor:5} {m:6} {p:70} {st} {det} {'' if ok else txt[:140]}")
print(f'\n{len(CASOS)} casos, {fallas} fallas')
