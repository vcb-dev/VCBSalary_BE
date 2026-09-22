import { FilesService } from '../files.service';
import {
  assertFileAllowed,
  extractExtension,
  MAX_FILE_SIZE_BYTES,
  sanitizeFileName,
} from '../../../common/utils/file-validation.util';

function makePrismaMock() {
  const mock = {
    fileAttachment: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    trafficRecordAttachment: {
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation(
    (work: (tx: typeof mock) => Promise<unknown>) => work(mock),
  );
  return mock;
}

function makeStorageMock() {
  return {
    upload: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    createSignedUrl: jest.fn(),
  };
}

const OWNER_ID = 'user-owner';
const OTHER_USER_ID = 'user-other';

describe('FilesService', () => {
  describe('upload', () => {
    it('rejects a disallowed file before ever touching storage or the DB', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      const service = new FilesService(prisma as never, storage as never);

      await expect(
        service.upload(
          {
            originalname: 'virus.exe',
            mimetype: 'application/x-msdownload',
            size: 10,
            buffer: Buffer.from('x'),
          },
          OWNER_ID,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

      expect(storage.upload).not.toHaveBeenCalled();
      expect(prisma.fileAttachment.create).not.toHaveBeenCalled();
    });

    it('uploads to storage then persists metadata, returning a public shape without storageKey', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.create.mockResolvedValue({
        id: 'file-1',
        uploadedByUserId: OWNER_ID,
        originalFileName: 'bao-cao.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: BigInt(2048),
        storageKey: 'secret-key-should-not-leak',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const service = new FilesService(prisma as never, storage as never);

      const result = await service.upload(
        {
          originalname: 'báo cáo.pdf',
          mimetype: 'application/pdf',
          size: 2048,
          buffer: Buffer.from('pdf-bytes'),
        },
        OWNER_ID,
      );

      expect(storage.upload).toHaveBeenCalledTimes(1);
      expect(result).not.toHaveProperty('storageKey');
      expect(result.fileSizeBytes).toBe(2048); // BigInt -> Number cho JSON-safe
      expect(result.id).toBe('file-1');
    });

    it('removes the uploaded object when persisting metadata fails', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.create.mockRejectedValue(new Error('DB down'));
      const service = new FilesService(prisma as never, storage as never);

      await expect(
        service.upload(
          {
            originalname: 'bao-cao.pdf',
            mimetype: 'application/pdf',
            size: 100,
            buffer: Buffer.from('pdf'),
          },
          OWNER_ID,
        ),
      ).rejects.toThrow('DB down');

      expect(storage.upload).toHaveBeenCalledTimes(1);
      expect(storage.remove).toHaveBeenCalledWith(
        expect.stringMatching(/-bao-cao\.pdf$/),
      );
    });
  });

  describe('getOne', () => {
    it('returns metadata plus a fresh signed download URL for the owner', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedByUserId: OWNER_ID,
        originalFileName: 'a.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: BigInt(100),
        storageKey: 'key-1',
        createdAt: new Date(),
      });
      storage.createSignedUrl.mockResolvedValue('https://signed.example/a');
      const service = new FilesService(prisma as never, storage as never);

      const result = await service.getOne(OWNER_ID, 'file-1');

      expect(result.downloadUrl).toBe('https://signed.example/a');
      expect(storage.createSignedUrl).toHaveBeenCalledWith('key-1');
    });

    it('blocks a non-owner with OUT_OF_SCOPE', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedByUserId: OWNER_ID,
        originalFileName: 'a.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: BigInt(100),
        storageKey: 'key-1',
        createdAt: new Date(),
      });
      const service = new FilesService(prisma as never, storage as never);

      await expect(
        service.getOne(OTHER_USER_ID, 'file-1'),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
      expect(storage.createSignedUrl).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND when the attachment does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.fileAttachment.findUnique.mockResolvedValue(null);
      const service = new FilesService(
        prisma as never,
        makeStorageMock() as never,
      );

      await expect(service.getOne(OWNER_ID, 'missing')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('getManyForAuthorizedAccess', () => {
    it('loads metadata in one query and creates signed URLs in parallel', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.findMany.mockResolvedValue([
        {
          id: 'file-1',
          uploadedByUserId: OWNER_ID,
          originalFileName: 'a.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 100n,
          storageKey: 'key-1',
          createdAt: new Date(),
        },
        {
          id: 'file-2',
          uploadedByUserId: OWNER_ID,
          originalFileName: 'b.pdf',
          mimeType: 'application/pdf',
          fileSizeBytes: 200n,
          storageKey: 'key-2',
          createdAt: new Date(),
        },
      ]);
      storage.createSignedUrl
        .mockResolvedValueOnce('https://signed.example/a')
        .mockResolvedValueOnce('https://signed.example/b');
      const service = new FilesService(prisma as never, storage as never);

      const result = await service.getManyForAuthorizedAccess([
        'file-1',
        'file-2',
      ]);

      expect(prisma.fileAttachment.findMany).toHaveBeenCalledTimes(1);
      expect(storage.createSignedUrl).toHaveBeenCalledTimes(2);
      expect(result.map((attachment) => attachment.id)).toEqual([
        'file-1',
        'file-2',
      ]);
    });
  });

  describe('remove', () => {
    it('deletes metadata transactionally with storage removal, for the owner', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedByUserId: OWNER_ID,
        originalFileName: 'a.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: BigInt(100),
        storageKey: 'key-1',
        createdAt: new Date(),
      });
      const service = new FilesService(prisma as never, storage as never);

      await service.remove(OWNER_ID, 'file-1');

      expect(storage.remove).toHaveBeenCalledWith('key-1');
      expect(prisma.fileAttachment.delete).toHaveBeenCalledWith({
        where: { id: 'file-1' },
      });
      expect(
        prisma.fileAttachment.delete.mock.invocationCallOrder[0],
      ).toBeLessThan(storage.remove.mock.invocationCallOrder[0]);
    });

    it('does not delete the DB row when the non-owner is blocked', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedByUserId: OWNER_ID,
        originalFileName: 'a.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: BigInt(100),
        storageKey: 'key-1',
        createdAt: new Date(),
      });
      const service = new FilesService(prisma as never, storage as never);

      await expect(
        service.remove(OTHER_USER_ID, 'file-1'),
      ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.fileAttachment.delete).not.toHaveBeenCalled();
    });

    it('blocks deletion while the file is attached as business evidence', async () => {
      const prisma = makePrismaMock();
      const storage = makeStorageMock();
      prisma.fileAttachment.findUnique.mockResolvedValue({
        id: 'file-1',
        uploadedByUserId: OWNER_ID,
        originalFileName: 'a.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 100n,
        storageKey: 'key-1',
        createdAt: new Date(),
      });
      prisma.trafficRecordAttachment.count.mockResolvedValue(1);
      const service = new FilesService(prisma as never, storage as never);

      await expect(service.remove(OWNER_ID, 'file-1')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.fileAttachment.delete).not.toHaveBeenCalled();
    });
  });
});

describe('file validation', () => {
  describe('assertFileAllowed', () => {
    it('accepts a valid PDF within the size limit', () => {
      expect(() =>
        assertFileAllowed({
          originalname: 'bao-cao.pdf',
          mimetype: 'application/pdf',
          size: 1024,
        }),
      ).not.toThrow();
    });

    it('rejects a file larger than MAX_FILE_SIZE_BYTES', () => {
      expect(() =>
        assertFileAllowed({
          originalname: 'anh.png',
          mimetype: 'image/png',
          size: MAX_FILE_SIZE_BYTES + 1,
        }),
      ).toThrow();
    });

    it('rejects an unsupported MIME type', () => {
      expect(() =>
        assertFileAllowed({
          originalname: 'script.exe',
          mimetype: 'application/x-msdownload',
          size: 100,
        }),
      ).toThrow();
    });

    it('rejects when the extension does not match the declared MIME type', () => {
      expect(() =>
        assertFileAllowed({
          originalname: 'anh.exe',
          mimetype: 'image/png',
          size: 100,
        }),
      ).toThrow();
    });
  });

  describe('extractExtension', () => {
    it('returns the lowercased extension including the dot', () => {
      expect(extractExtension('Bao-Cao.PDF')).toBe('.pdf');
    });

    it('returns an empty string when there is no extension', () => {
      expect(extractExtension('no-extension')).toBe('');
    });
  });

  describe('sanitizeFileName', () => {
    it('keeps normal Vietnamese names and spaces intact', () => {
      expect(sanitizeFileName('báo cáo tháng 9.pdf')).toBe(
        'báo cáo tháng 9.pdf',
      );
    });

    it('replaces unsafe path characters and keeps the extension', () => {
      expect(sanitizeFileName('a/b\\c?d.png')).toBe('a_b_c_d.png');
    });

    it('falls back to "file" when there is no base name before the extension', () => {
      expect(sanitizeFileName('.png')).toBe('file.png');
    });
  });
});
