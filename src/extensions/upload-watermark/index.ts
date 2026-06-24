/**
 * Server-side lookbook watermarking.
 *
 * Ports the build-time watermarker from the landing repo
 * (scripts/watermark-lookbook.mjs) into the Strapi upload pipeline so the salon
 * owner can drag-drop a raw photo and have the gold wordmark baked into the
 * stored bytes — preserving brand protection on right-click "Save image as…".
 *
 * How it hooks in: the upload plugin runs `image-manipulation.optimize(file)`
 * for every optimizable image (jpeg/png/webp/tiff/avif) inside
 * `enhanceAndValidateFile`, BEFORE the provider uploads it to GCS and before
 * thumbnails/responsive formats are derived. We wrap that method, composite the
 * watermark onto the optimized buffer, and hand back a file object of the same
 * shape. Thumbnails generated afterwards inherit the mark for free.
 *
 * Scope: by default every uploaded image is watermarked. Two opt-out knobs:
 *   - WATERMARK_EXCLUDE_FOLDERS — comma-separated Media Library folder names
 *     (e.g. "Hero,Estudio") whose images stay UNMARKED. Best for rarely-changed
 *     non-lookbook media (hero background, studio photos) while the frequent
 *     lookbook uploads keep watermarking with zero folder fuss.
 *   - WATERMARK_FOLDER — a single folder name to restrict marking to ONLY that
 *     folder (inverse logic). When set, it wins over the exclude list.
 * Either way, promo banners / bio avatars / hero / studio shots can avoid the
 * nail wordmark.
 *
 * Safety: any failure logs and falls through to the un-watermarked file, so a
 * watermarking bug can never block an upload.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Core } from '@strapi/strapi';

// Tuned to match the landing's watermark-lookbook.mjs SETTINGS exactly.
const SETTINGS = {
  WIDTH_RATIO: 0.32,
  OPACITY: 0.28,
  PADDING_PCT: 0.04,
  JPEG_QUALITY: 88,
  SVG_DENSITY: 200,
};

// Strapi's loosely-typed upload file object (the fields we touch).
type UploadFile = {
  hash: string;
  ext?: string;
  mime?: string;
  filepath?: string;
  tmpWorkingDirectory?: string;
  folder?: number | { id: number };
  folderPath?: string;
  width?: number;
  height?: number;
  size?: number;
  sizeInBytes?: number;
  getStream: () => NodeJS.ReadableStream;
};

let watermarkSvgPath = '';

// Rasterize + trim the wordmark once, then cache each target width. The trim
// makes WIDTH_RATIO refer to the visible mark, not the SVG's padded canvas.
let trimmedPromise: Promise<Buffer> | null = null;
function getTrimmedWatermark(): Promise<Buffer> {
  if (!trimmedPromise) {
    trimmedPromise = (async () => {
      const svg = await fs.promises.readFile(watermarkSvgPath);
      return sharp(svg, { density: SETTINGS.SVG_DENSITY }).trim().png().toBuffer();
    })();
  }
  return trimmedPromise;
}

const sizedCache = new Map<number, Buffer>();
async function getSizedWatermark(width: number): Promise<Buffer> {
  const cached = sizedCache.get(width);
  if (cached) return cached;
  const base = await getTrimmedWatermark();
  const buf = await sharp(base)
    .resize({ width })
    .composite([
      {
        // Uniformly scale the mark's alpha to OPACITY via a tiled dest-in.
        input: {
          create: {
            width: 1,
            height: 1,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: SETTINGS.OPACITY },
          },
        },
        tile: true,
        blend: 'dest-in',
      },
    ])
    .png()
    .toBuffer();
  sizedCache.set(width, buf);
  return buf;
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Composite the wordmark bottom-right and return a file object Strapi can keep
// using (same getStream/filepath contract as image-manipulation.optimize).
async function watermarkFile(
  file: UploadFile,
  strapi: Core.Strapi,
): Promise<UploadFile> {
  const inputBuf = await streamToBuffer(file.getStream());
  const meta = await sharp(inputBuf, { failOn: 'none' }).metadata();
  const imgW = meta.width ?? 1600;
  const imgH = meta.height ?? 1200;

  const targetW = Math.max(1, Math.round(imgW * SETTINGS.WIDTH_RATIO));
  const wm = await getSizedWatermark(targetW);
  const wmMeta = await sharp(wm).metadata();
  const wmW = wmMeta.width ?? targetW;
  const wmH = wmMeta.height ?? 0;
  const pad = Math.round(imgW * SETTINGS.PADDING_PCT);
  const top = Math.max(0, imgH - wmH - pad);
  const left = Math.max(0, imgW - wmW - pad);

  // Input is already EXIF-oriented by optimize(); do not rotate again.
  let pipeline = sharp(inputBuf, { failOn: 'none' }).composite([
    { input: wm, top, left },
  ]);
  switch (meta.format) {
    case 'png':
      pipeline = pipeline.png();
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: SETTINGS.JPEG_QUALITY });
      break;
    case 'tiff':
      pipeline = pipeline.tiff();
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality: SETTINGS.JPEG_QUALITY });
      break;
    default:
      pipeline = pipeline.jpeg({ quality: SETTINGS.JPEG_QUALITY, mozjpeg: true });
  }
  const outBuf = await pipeline.toBuffer();

  const dir = file.tmpWorkingDirectory ?? (file.filepath ? path.dirname(file.filepath) : '.');
  const outPath = path.join(dir, `watermarked-${file.hash}`);
  await fs.promises.writeFile(outPath, outBuf);

  strapi.log.debug(`[upload-watermark] marked ${file.hash} (${meta.format}, ${imgW}x${imgH})`);

  return Object.assign({}, file, {
    filepath: outPath,
    getStream: () => fs.createReadStream(outPath),
    width: imgW,
    height: imgH,
    size: Math.round((outBuf.length / 1000) * 100) / 100,
    sizeInBytes: outBuf.length,
  });
}

async function resolveFolderName(
  file: UploadFile,
  strapi: Core.Strapi,
): Promise<string | null> {
  const folderId =
    typeof file.folder === 'object' ? file.folder?.id : file.folder;
  if (!folderId) return null;
  const folder = await strapi.db
    .query('plugin::upload.folder')
    .findOne({ where: { id: folderId } });
  return folder?.name ?? null;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function shouldWatermark(
  file: UploadFile,
  strapi: Core.Strapi,
): Promise<boolean> {
  if (process.env.WATERMARK_ENABLED === 'false') return false;

  // Inverse mode: only the named folder gets watermarked.
  const includeOnly = process.env.WATERMARK_FOLDER?.trim();
  if (includeOnly) {
    const name = await resolveFolderName(file, strapi);
    return name === includeOnly;
  }

  // Default mode: watermark everything except the excluded folders.
  const excluded = parseList(process.env.WATERMARK_EXCLUDE_FOLDERS);
  if (excluded.length === 0) return true;
  const name = await resolveFolderName(file, strapi);
  return !(name && excluded.includes(name));
}

let patched = false;

/**
 * Wraps the upload plugin's image-manipulation.optimize() once at bootstrap.
 * Idempotent (guards against double-patching on hot reload).
 */
export function registerWatermark(strapi: Core.Strapi): void {
  if (patched) return;
  watermarkSvgPath = path.join(
    strapi.dirs.app.root,
    'src',
    'extensions',
    'upload-watermark',
    'LogoText.svg',
  );
  if (!fs.existsSync(watermarkSvgPath)) {
    strapi.log.warn(
      `[upload-watermark] wordmark not found at ${watermarkSvgPath} — watermarking disabled`,
    );
    return;
  }

  const im: any = strapi.plugin('upload').service('image-manipulation');
  if (!im || typeof im.optimize !== 'function' || im.__watermarkPatched) return;

  const originalOptimize = im.optimize.bind(im);
  im.optimize = async (file: UploadFile) => {
    const optimized = await originalOptimize(file);
    try {
      if (await shouldWatermark(file, strapi)) {
        return await watermarkFile(optimized, strapi);
      }
    } catch (err: any) {
      strapi.log.error(
        `[upload-watermark] failed for ${file?.hash}, serving unmarked: ${err?.message}`,
      );
    }
    return optimized;
  };
  im.__watermarkPatched = true;
  patched = true;

  const includeOnly = process.env.WATERMARK_FOLDER?.trim();
  const excluded = parseList(process.env.WATERMARK_EXCLUDE_FOLDERS);
  const scopeDesc = includeOnly
    ? `only folder "${includeOnly}"`
    : excluded.length
      ? `all images except folders [${excluded.join(', ')}]`
      : 'all images';
  strapi.log.info(`[upload-watermark] active (scope: ${scopeDesc})`);
}
