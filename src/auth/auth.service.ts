import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  getAuth,
  signInWithEmailAndPassword,
  UserCredential,
} from 'firebase/auth';
import { LoginDto } from './dto';
import { initializeApp } from 'firebase/app';
import { ConfigService } from '@nestjs/config';
import { AdminService } from '../admin/admin.service';
import { UsersService } from '../users/users.service';
import { FirebaseAuthPort } from '../firebase/ports/firebase-auth.port';

@Injectable()
export class AuthService {
  private defaultApp: any;

  public constructor(
    private readonly config: ConfigService,
    @Inject(forwardRef(() => AdminService))
    private readonly adminService: AdminService,
    private readonly usersService: UsersService,
    private readonly firebaseAuth: FirebaseAuthPort,
  ) {
    if (config.get('FIREBASE_APP_API_KEY')) {
      this.defaultApp = initializeApp({
        apiKey: config.get('FIREBASE_APP_API_KEY'),
      });
    }
  }

  checkIfTokenValid() {
    return new HttpException('token valid', HttpStatus.CONTINUE);
  }

  async login(dto: LoginDto, requestSource?: string) {
    try {
      const auth = getAuth();
      const userCredential: UserCredential = await signInWithEmailAndPassword(
        auth,
        dto.email,
        dto.password,
      );

      return userCredential;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  public async decodeToken(token: string) {
    try {
      const decodedToken = await this.firebaseAuth.verifyIdToken(token);

      const user = {
        email: decodedToken.email || '',
        user: decodedToken.user_id,
        sub: decodedToken.sub,
      };

      return user;
    } catch (error) {
      throw new UnauthorizedException(error);
    }
  }

  public async loginDashboard(token: string) {
    const user = await this.decodeToken(token);

    if (!user.email) {
      throw new UnauthorizedException('Invalid token payload');
    }

    try {
      const admin = await this.adminService.findOneByEmail(user.email);

      if (!admin) {
        throw new UnauthorizedException('Admin not found');
      }
    } catch (error) {
      throw new UnauthorizedException(error);
    }
  }
}
