/**
 * The system clipboard only takes PNG from the web API, so any other image
 * format is redrawn through a canvas first.
 */
export async function copyImageToClipboard(src: string): Promise<void> {
  const image = new Image()
  image.src = src
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('no 2d canvas context')
  context.drawImage(image, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(result => (result ? resolve(result) : reject(new Error('png encode failed'))), 'image/png'),
  )
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
