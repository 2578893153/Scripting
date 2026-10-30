import { Path } from 'scripting'

/**
 * 内置车图只从 Gitee 取，脚本目录里不再放 car.png：换车图不用重新分发脚本。
 * 视图渲染是同步的、`Image filePath` 也只认本地路径，所以要先下载落盘再画。
 */
const CAR_ASSET_URL =
  'https://raw.giteeusercontent.com/script_gf/scripting/raw/master/car.png?metadata=eyJyIjoibWFzdGVyIiwiZnAiOiJjYXIucG5nIiwidWlkIjoxMDY4ODYxNywicGlkIjo1MTE0NTY0Miwic3RvIjoiZ2l0LXNoYXJkaW5nLXN0by00MnQtMDA5IiwicnAiOiJyZXBvcy81MC9iOS81MGI5MDk3MjZlY2JkYWZjMDA3MzczYmMyYmJhMmY0NjY3MzM0ODM1MmJiZjJkYTMwZmEzMDBhYTE0YjY0Y2NlLmdpdCIsImlzcCI6dHJ1ZSwiZXhwaXJlX2F0IjoxNzkzMjU5NjAwfQ&signature=nC8mmAQRPz_lR69jVtt3xa_y_rKTGtlcWdmbuUk_69U'

/** 落盘位置：临时目录由系统自己清理，文件没了下次渲染会重新下。 */
const CACHE_PATH = Path.join(FileManager.temporaryDirectory, 'car-default.png')
/** 缓存有效期：过一周重下一次，仓库里换了图最多一周生效。 */
const TTL = 7 * 24 * 60 * 60 * 1000
const STAMP_KEY = 'carAssetAt'

/** 渲染时要的路径：始终是缓存路径，有没有文件由 `hasDefaultCar()` 判断。 */
export function defaultCarPath(): string {
  return CACHE_PATH
}

export function hasDefaultCar(): boolean {
  try { return !!FileManager.existsSync(CACHE_PATH) } catch { return false }
}

/**
 * 确保内置车图已落盘。有缓存且没过期就直接返回，不联网。
 * 下载失败不抛错：有旧缓存就继续用，第一次就下不到只能是空车图（组件照常显示）。
 */
export async function prepareDefaultCar(force = false): Promise<boolean> {
  const cached = hasDefaultCar()
  if (!force && cached) {
    let at = 0
    try { at = Number(Storage.get<string>(STAMP_KEY) || 0) } catch { at = 0 }
    if (Date.now() - at < TTL) return true
  }
  try {
    const image = await UIImage.fromURL(CAR_ASSET_URL)
    const data = image ? image.toPNGData() : null
    if (!data) return cached
    FileManager.writeAsDataSync(CACHE_PATH, data)
    Storage.set(STAMP_KEY, String(Date.now()))
    return true
  } catch (e) {
    return cached
  }
}
