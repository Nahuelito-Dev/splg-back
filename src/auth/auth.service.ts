import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseApp, initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  UserCredential,
} from 'firebase/auth';
import { LoginDto, SesionIniciadaDto, TokenValidoResponseDto } from './dto';
import { AdminService } from '../admin/admin.service';
import { UsersService } from '../users/users.service';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';
import { errorCode, errorMessage } from '../common/errors/error-message';

/** Lo que el backend toma de un token de Firebase ya verificado. */
export interface TokenDecodificado {
  email: string;
  user: string;
  sub: string;
}

@Injectable()
export class AuthService {
  /** App del SDK de cliente, para el acceso con email y contraseña. */
  private readonly clientApp: FirebaseApp | null;

  public constructor(
    config: ConfigService,
    private readonly adminService: AdminService,
    private readonly usersService: UsersService,
    private readonly firebaseAuth: FirebaseAuthPort,
  ) {
    const apiKey = config.get<string>('FIREBASE_APP_API_KEY');
    this.clientApp = apiKey ? initializeApp({ apiKey }) : null;
  }

  checkIfTokenValid(): TokenValidoResponseDto {
    return TokenValidoResponseDto.crear();
  }

  /**
   * Inicia sesión y devuelve **sólo** el token de acceso y quién es la persona.
   *
   * Antes devolvía el `UserCredential` del SDK tal cual llegaba, con el
   * `refreshToken` —que es de vida larga— y la clave del proyecto adentro.
   * Acá se traduce a un objeto propio: lo que sale de este servicio es
   * nuestro contrato, no el del proveedor.
   */
  async login(dto: LoginDto): Promise<SesionIniciadaDto> {
    let credencial: UserCredential;
    try {
      const auth = this.clientApp ? getAuth(this.clientApp) : getAuth();
      credencial = await signInWithEmailAndPassword(
        auth,
        dto.email,
        dto.password,
      );
    } catch (error) {
      // Una cuenta deshabilitada (baja lógica, H-74) responde igual que una
      // dada de baja o bloqueada, sin el texto de Firebase.
      if (errorCode(error) === 'auth/user-disabled') {
        throw new UnauthorizedException('La cuenta no está habilitada');
      }
      throw new HttpException(errorMessage(error), HttpStatus.BAD_REQUEST);
    }

    // Firebase sólo dice que la contraseña es correcta. Que la cuenta siga
    // habilitada en el sistema lo decidimos nosotros: una cuenta dada de baja
    // o bloqueada no recibe token, aunque la contraseña sea la buena.
    await this.assertCuentaHabilitada(dto.email);

    return this.aSesionIniciada(credencial);
  }

  /**
   * Una cuenta dada de baja no existe para `findOneByEmail` (TypeORM excluye
   * las borradas lógicamente), y una bloqueada existe pero no puede operar.
   * En los dos casos la respuesta es la misma para afuera, para no revelar
   * cuál de las dos situaciones es.
   */
  private async assertCuentaHabilitada(email: string): Promise<void> {
    let bloqueada: boolean;
    try {
      bloqueada = (await this.usersService.findOneByEmail(email)).blocked;
    } catch {
      throw new UnauthorizedException('La cuenta no está habilitada');
    }
    if (bloqueada) {
      throw new UnauthorizedException('La cuenta no está habilitada');
    }
  }

  /** Traduce lo que devuelve Firebase al contrato de la API. */
  private async aSesionIniciada(
    credencial: UserCredential,
  ): Promise<SesionIniciadaDto> {
    const usuario = credencial.user;
    // El token recién emitido: getIdTokenResult lo toma del caché del SDK.
    const token = await usuario.getIdTokenResult();
    const vence = Date.parse(token.expirationTime);

    return {
      accessToken: token.token,
      expiresIn: Number.isNaN(vence)
        ? 3600
        : Math.max(0, Math.round((vence - Date.now()) / 1000)),
      user: {
        uid: usuario.uid,
        email: usuario.email ?? '',
        displayName: usuario.displayName ?? null,
        phoneNumber: usuario.phoneNumber ?? null,
        emailVerified: usuario.emailVerified,
      },
    };
  }

  /**
   * Verifica el token contra Firebase. Si no es válido responde 401 y conserva
   * el `code` del error de Firebase (`auth/id-token-expired`,
   * `auth/argument-error`...): es lo que un cliente mira para saber si tiene
   * que volver a iniciar sesión.
   */
  public async decodeToken(token: string): Promise<TokenDecodificado> {
    try {
      const decoded = await this.firebaseAuth.verifyIdToken(token);
      const userId: unknown = decoded['user_id'];
      return {
        email: decoded.email ?? '',
        user: typeof userId === 'string' ? userId : decoded.uid,
        sub: decoded.sub,
      };
    } catch (error) {
      throw new UnauthorizedException({
        statusCode: HttpStatus.UNAUTHORIZED,
        error: 'Unauthorized',
        message: errorMessage(error),
        code: errorCode(error),
      });
    }
  }

  /** El panel sólo admite cuentas que tengan un perfil de administrador. */
  public async loginDashboard(token: string): Promise<void> {
    const { email } = await this.decodeToken(token);

    if (!email) {
      throw new UnauthorizedException('Invalid token payload');
    }

    let esAdmin: boolean;
    try {
      esAdmin = Boolean(await this.adminService.findOneByEmail(email));
    } catch {
      esAdmin = false;
    }
    if (!esAdmin) {
      throw new UnauthorizedException('Admin not found');
    }
  }
}
