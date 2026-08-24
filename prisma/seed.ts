import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  const password = await bcrypt.hash('Admin@123', 10);

  await prisma.user.createMany({
    data: [
      {
        email: 'admin@vcbsalary.vn',
        password,
        fullName: 'Nguyễn Minh Anh',
        role: 'ADMIN',
      },
      {
        email: 'hr@vcbsalary.vn',
        password,
        fullName: 'Trần Thị Hương',
        role: 'HR',
      },
    ],
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
