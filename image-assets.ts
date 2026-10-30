import { Path, Script } from 'scripting'
import type { WidgetOptions, WidgetSize } from './settings'

/** 各尺寸组件在 @3x 屏幕上的实际像素，背景按 cover 裁到这个尺寸就够了。 */
const BACKGROUND_PIXELS: Record<WidgetSize, { width: number; height: number }> = {
  small: { width: 480, height: 480 },
  medium: { width: 1020, height: 480 },
  large: { width: 850, height: 890 },
  extraLarge: { width: 910, height: 955 },
}
/** 车图最长边：组件里实际最多显示约 700px（medium/large 上的大车图），720px 刚好覆盖且不浪费。 */
const CAR_MAX_PIXELS = 720
/** 背景 JPEG 质量：0.9 在正常观看距离下与 PNG 无差别，体积小一个量级。 */
const BACKGROUND_QUALITY = 0.9
/** 文件名里的标记，用来判断这张图已经压缩过（旧图没有这个标记）。 */
const MARKER = '-opt'
const OPTIMIZED_SUFFIX = new RegExp(MARKER.replace('-', '\\-') + '\\.(?:png|jpe?g)$', 'i')

export type ImageKey = 'carImage' | 'centerCarImage' | keyof Pick<WidgetOptions, 'smallBackground' | 'mediumBackground' | 'largeBackground' | 'extraLargeBackground'>

export function assetDirectory(): string {
  return Path.join(FileManager.appGroupDocumentsDirectory, 'CarLinkCustomization', encodeURIComponent(Script.name))
}

/** 只处理我们自己写在 App Group 里的图，脚本目录自带 car.png 之类一律不动。 */
function isManaged(path: string): boolean {
  return !!path && path.indexOf(assetDirectory() + '/') === 0
}

function isOptimized(path: string): boolean {
  // 必须按“后缀”判定：旧算法用 basename 里是否包含 -opt，名字带 option / opt 的原图
  // 会被误判成已压缩，于是 1000px 的大图永远不再精简，白占空间。
  return OPTIMIZED_SUFFIX.test(Path.basename(path))
}

function pixelsOf(image: UIImage) {
  const scale = image.scale > 0 ? image.scale : 1
  return { width: image.width * scale, height: image.height * scale, scale }
}

/**
 * 缩到目标像素：cover 用于背景（裁掉多余部分，和组件的 scaleToFill 一致），
 * fit 用于车图（整张保留，不裁车身）。
 * preparingThumbnail 的入参是 point 且保留源图 scale，所以这里统一换算成像素再回推 point。
 */
function resizeToPixels(image: UIImage, target: { width: number; height: number }, mode: 'cover' | 'fit'): UIImage {
  const src = pixelsOf(image)
  if (!(src.width > 0) || !(src.height > 0)) return image
  const ratio = mode === 'cover'
    ? Math.max(target.width / src.width, target.height / src.height)
    : Math.min(target.width / src.width, target.height / src.height)
  // 小图不放大：放大只增加内存，不会更清晰。
  const k = Math.min(1, ratio)
  const width = Math.max(1, Math.round(src.width * k))
  const height = Math.max(1, Math.round(src.height * k))
  let out = image
  if (width < Math.round(src.width) || height < Math.round(src.height)) {
    out = image.preparingThumbnail({ width: width / src.scale, height: height / src.scale }) || image
  }
  if (mode !== 'cover') return out

  const now = pixelsOf(out)
  const cropWidth = Math.min(target.width, Math.round(now.width))
  const cropHeight = Math.min(target.height, Math.round(now.height))
  if (cropWidth >= Math.round(now.width) && cropHeight >= Math.round(now.height)) return out
  const cropped = out.croppedTo({
    x: (now.width - cropWidth) / 2 / now.scale,
    y: (now.height - cropHeight) / 2 / now.scale,
    width: cropWidth / now.scale,
    height: cropHeight / now.scale,
  })
  return cropped || out
}

/** 背景可能是带透明的 PNG（贴纸、截图），这类保留 PNG，其余压成 JPEG。 */
function hasTransparency(image: UIImage): boolean {
  const probe = image.preparingThumbnail({ width: 48, height: 48 }) || image
  const raw = probe.getPixelData()
  const bytes = raw?.data.toUint8Array()
  if (!bytes) return true
  for (let i = 3; i < bytes.length; i += 4) {
    if (bytes[i] < 250) return true
  }
  return false
}

function kindOf(key: ImageKey): 'car' | 'background' {
  return key === 'carImage' || key === 'centerCarImage' ? 'car' : 'background'
}

function prepare(image: UIImage, key: ImageKey, size: WidgetSize): UIImage {
  if (kindOf(key) === 'car') {
    return resizeToPixels(image, { width: CAR_MAX_PIXELS, height: CAR_MAX_PIXELS }, 'fit')
  }
  return resizeToPixels(image, BACKGROUND_PIXELS[size], 'cover')
}

async function write(image: UIImage, key: ImageKey, size: WidgetSize): Promise<string> {
  const prepared = prepare(image, key, size)
  const background = kindOf(key) === 'background'
  const keepAlpha = background && hasTransparency(prepared)
  const data = background && !keepAlpha
    ? Data.fromJPEG(prepared, BACKGROUND_QUALITY)
    : Data.fromPNG(prepared)
  if (!data) throw new Error('图片转换失败')

  const dir = assetDirectory()
  await FileManager.createDirectory(dir, true)
  const ext = background && !keepAlpha ? 'jpg' : 'png'
  const path = Path.join(dir, size + '-' + key + '-' + Date.now() + MARKER + '.' + ext)
  await FileManager.writeAsData(path, data)
  return path
}

/** 导入时的唯一入口：按组件实际显示尺寸缩图，返回落盘后的路径。 */
export async function saveWidgetImage(image: UIImage, key: ImageKey, size: WidgetSize): Promise<string> {
  return write(image, key, size)
}

/**
 * 旧版本存的是 1000×1000 的 PNG，进「车图与背景」时静默重存成压缩后的版本。
 * 只返回新路径，不删除旧文件：多个尺寸/配置可能共用同一张图。
 */
export async function compactSavedImage(path: string, key: ImageKey, size: WidgetSize): Promise<string | null> {
  if (!isManaged(path) || isOptimized(path) || !FileManager.existsSync(path)) return null
  const image = UIImage.fromFile(path)
  if (!image) return null
  return write(image, key, size)
}
