import { Prisma, User } from "@prisma/client";
import { prisma } from "../../../prisma/client";

// All User database access. No Prisma outside repositories (HOA protocol 04).

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  photoUrl: string | null;
}

export class UserRepository {
  async findActiveById(id: string): Promise<User | null> {
    return prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * Sign-in: create the account on first sign-in, otherwise refresh its profile from Google (there
   * is no in-app profile editing to preserve). Matching is by Google `sub` only — never by email,
   * which a user can change. A deleted account's `sub` was cleared, so it never matches here and
   * signing in again creates a fresh account.
   *
   * Two first sign-ins racing each other: the loser hits the unique index (P2002) and updates the
   * row the winner created.
   */
  async upsertFromGoogle(profile: GoogleProfile): Promise<{ user: User; isNew: boolean }> {
    const data = { email: profile.email, name: profile.name, photoUrl: profile.photoUrl };
    const existing = await prisma.user.findUnique({ where: { googleSub: profile.sub } });
    if (existing) {
      return { user: await prisma.user.update({ where: { id: existing.id }, data }), isNew: false };
    }
    try {
      const user = await prisma.user.create({ data: { googleSub: profile.sub, ...data } });
      return { user, isNew: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await prisma.user.findUniqueOrThrow({ where: { googleSub: profile.sub } });
        return { user: await prisma.user.update({ where: { id: winner.id }, data }), isNew: false };
      }
      throw err;
    }
  }

  /**
   * Account deletion, in ONE transaction: sign out every device and anonymise the user. The row
   * itself stays as an anonymous anchor for records the law makes us keep (statements and payments,
   * from P5); everything that identifies the person is cleared.
   */
  async anonymiseAndSignOut(userId: string, now: Date): Promise<void> {
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { userId } }),
      prisma.user.update({
        where: { id: userId },
        data: { googleSub: null, email: null, name: null, photoUrl: null, deletedAt: now },
      }),
    ]);
  }
}

export const userRepository = new UserRepository();
