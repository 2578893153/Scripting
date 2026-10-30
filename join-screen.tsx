import { Button, Image, Navigation, NavigationStack, Path, ScrollView, Text, VStack } from 'scripting'

/** 一张码：`file` 只当落盘与存相册用的名字，图一律从 `url` 下。 */
type PosterSource = { file: string; url: string }

/** 入群入口：两张码图都走 Gitee（换图不用重新分发脚本）。 */
const POSTERS: PosterSource[] = [
  {
    file: 'VXQ.PNG',
    url: 'https://raw.giteeusercontent.com/script_gf/scripting/raw/master/VXQ.PNG?metadata=eyJyIjoibWFzdGVyIiwiZnAiOiJWWFEuUE5HIiwidWlkIjoxMDY4ODYxNywicGlkIjo1MTE0NTY0Miwic3RvIjoiZ2l0LXNoYXJkaW5nLXN0by00MnQtMDA5IiwicnAiOiJyZXBvcy81MC9pT1M1MGQ5MDk3MjZlY2JkYWZjMDA3MzczYmMyYmJhMmY0NjY3MzM0ODM1MmJiZjJkYTMwZmEzMDBhYTE0YjY0Y2NlLmdpdCIsImlzcCI6dHJ1ZSwiZXhwaXJlX2F0IjoxNzkzMjU5NjAwfQ&signature=673QyCq0FwJwXlzQwl3pcK5F2NzfWQKlNIinRMt3j0k',
  },
  {
    file: 'GZH.PNG',
    url: 'https://raw.giteeusercontent.com/script_gf/scripting/raw/master/GZH.PNG?metadata=eyJyIjoibWFzdGVyIiwiZnAiOiJHWkguUE5HIiwidWlkIjoxMDY4ODYxNywicGlkIjo1MTE0NTY0Miwic3RvIjoiZ2l0LXNoYXJkaW5nLXN0by00MnQtMDA5IiwicnAiOiJyZXBvcy81MC9pT1M1MGQ5MDk3MjZlY2JkYWZjMDA3MzczYmMyYmJhMmY0NjY3MzM0ODM1MmJiZjJkYTMwZmEzMDBhYTE0YjY0Y2NlLmdpdCIsImlzcCI6dHJ1ZSwiZXhwaXJlX2F0IjoxNzkzMjU5NjAwfQ&signature=Q50Vr-qG-wEcdcLMc38woWOZtjJcKUG1HyljaAWbOXg',
  },
]

/** 远程图先落盘：视图渲染是同步的，`UIImage` / `QRCode.parse` 也都只认本地路径。 */
function cachePath(file: string): string {
  return Path.join(FileManager.temporaryDirectory, 'join-' + file)
}

async function preparePoster(source: PosterSource): Promise<void> {
  try {
    const image = await UIImage.fromURL(source.url)
    const data = image ? image.toPNGData() : null
    if (!data) return
    FileManager.writeAsDataSync(cachePath(source.file), data)
  } catch (e) {
    // 下载失败就留着上次落盘的图，页面照常打开。
  }
}

/** 按图片真实比例算显示尺寸：弹性高度会压成 0，必须给显式宽高。 */
function posterFrame(image: UIImage): { width: number; height: number } {
  const width = Math.round(Math.max(240, Device.screen.width - 56))
  const ratio = image.height > 0 ? image.width / image.height : 1
  return { width, height: Math.round(width / ratio) }
}

/** 微信自家域名（群邀请是 u.wechat.com、公众号是 weixin.qq.com）在浏览器里只会跳下载页，必须回微信里认。 */
function isWeChatLink(url: string): boolean {
  const host = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()
  return /(^|\.)(wechat\.com|weixin\.qq\.com|weixin\.com)$/.test(host)
}

/** 存相册再唤起微信扫一扫：同一个屏幕没法自扫，只能借「从相册选取」。 */
async function followByAlbum(path: string, file: string): Promise<void> {
  let saved = false
  try {
    saved = await Photos.savePhoto(path, { fileName: file })
  } catch (e) {
    saved = false
  }
  if (!saved) {
    await Dialog.alert({ title: '存相册没成功', message: '可以先截图，再用微信「扫一扫 → 相册」选那张截图。' })
    return
  }
  await Dialog.alert({
    title: '图片已存到相册',
    message: '确定后打开微信扫一扫，点右上角「相册」选这张图，就能直接跳过去。',
  })
  let opened = false
  try {
    opened = await Safari.openURL('weixin://scanqrcode')
  } catch (e) {
    opened = false
  }
  if (!opened) await Dialog.alert({ title: '手动打开微信', message: '在微信里点「扫一扫 → 相册」，选刚存的图即可。' })
}

/** 点图片：先读图里的二维码，能直接开链接就开，微信链接改走相册识别。 */
async function openPosterQr(path: string, file: string): Promise<void> {
  if (!FileManager.existsSync(path)) {
    await Dialog.alert({ title: '缺少图片', message: file + ' 还没下载下来，稍后再点一次试试。' })
    return
  }
  let payload: string | null = null
  try {
    payload = await QRCode.parse(path)
  } catch (e) {
    payload = null
  }
  // 读不出来也照样能存相册让微信自己认，所以不当作失败处理。
  if (!payload || isWeChatLink(payload)) {
    await followByAlbum(path, file)
    return
  }
  try {
    const opened = await Safari.openURL(payload)
    if (!opened) await Dialog.alert({ title: '打开失败', message: payload })
  } catch (e) {
    await Dialog.alert({ title: '打开失败', message: String(e) })
  }
}

/** 一张码：整图铺满一屏宽，点一下当扫码，码本身够大也仍可被另一台手机扫。 */
function Poster({ source }: { source: PosterSource }) {
  const path = cachePath(source.file)
  // 直接用已解码的 UIImage：比路径更稳，预览里也不会空白。
  const image = UIImage.fromFile(path)
  const frame = image ? posterFrame(image) : null
  if (!image || !frame) return <Text font={13} foregroundStyle="#7B879B">图片没下载成功</Text>
  return (
    <Button action={() => openPosterQr(path, source.file)} buttonStyle="plain" frame={frame}>
      <Image image={image} resizable scaleToFit frame={frame} />
    </Button>
  )
}

/** 点「入群」直接进这一页：两张码图上下排开，都能点。 */
function JoinScreen() {
  const dismiss = Navigation.useDismiss()
  return (
    <NavigationStack>
      <ScrollView navigationTitle="加入我们" toolbar={{ cancellationAction: <Button title="完成" action={dismiss} /> }}>
        <VStack spacing={16} padding={16}>
          {POSTERS.map((source) => <Poster key={source.file} source={source} />)}
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}

/** 顶部「入群」按钮的入口：不起选择框，直接开合页。 */
export async function showJoinPage(): Promise<void> {
  await Promise.all(POSTERS.map(preparePoster))
  await Navigation.present({ element: <JoinScreen />, modalPresentationStyle: 'pageSheet' })
}
