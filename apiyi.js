const upstreamUrl = 'https://api.apiyi.com/v1/images/edits'
const model = 'gpt-image-2.5-sunburst'
const generationTimeout = 300_000
const maxImageBytes = 10 * 1024 * 1024
const pngSignature = '\x89PNG\r\n\x1a\n'

const prompt = [
  'Edit Image 1, the original dog photo. Use Image 2 only as the reference for the garment. Put that garment on the same dog in Image 1.',
  'Keep the dog’s facial features, expression, fur colors and markings, body proportions, and pose. Preserve the original crop, camera angle, background, and lighting. Limit changes to the area covered by the garment and its immediate shadows.',
  'Match the garment’s visible cut, colors, fabric texture, pattern placement, seams, trims, fasteners, and existing prints or logos. Use only the garment from Image 2 and leave out its white backdrop, props, and display shadows.',
  'Fit the garment to the dog’s existing anatomy. Place the neckline and leg openings around the neck and legs as appropriate to the reference. Make the fabric drape and fold naturally, with contact shadows and believable overlap at the fur edges. Keep the visible paws and limbs in their original positions.',
  'Return one realistic edited photo. Avoid collages, captions, watermarks, and new accessories or branding.',
].join('\n\n')

export class ApiYiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiYiError'
    this.status = status
  }
}

async function prepareImage(file, label, filename) {
  if (!(file instanceof Blob) || file.size === 0) {
    throw new ApiYiError(400, `请上传${label}。`)
  }
  if (file.size > maxImageBytes) {
    throw new ApiYiError(413, `${label}大小不能超过 10 MB。`)
  }

  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const signature = String.fromCharCode(...header)
  let extension
  let mime
  if (signature.startsWith(pngSignature)) {
    extension = 'png'
    mime = 'image/png'
  } else if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    extension = 'jpg'
    mime = 'image/jpeg'
  } else if (signature.startsWith('RIFF') && signature.slice(8) === 'WEBP') {
    extension = 'webp'
    mime = 'image/webp'
  } else {
    throw new ApiYiError(415, `${label}须为 JPG、PNG 或 WebP 格式。`)
  }

  return [file.slice(0, file.size, mime), `${filename}.${extension}`]
}

function upstreamError(status, payload) {
  const details = [payload?.error?.code, payload?.error?.message, payload?.message]
    .filter(value => typeof value === 'string')
    .join(' ')

  if (status === 401 || status === 403) {
    return new ApiYiError(status, 'API 易拒绝了请求，请检查 API 密钥是否有效并已开通图像模型权限。')
  }
  if (status === 402 || /insufficient|quota|余额不足|配额不足|额度不足/i.test(details)) {
    return new ApiYiError(402, 'API 易账户余额或额度不足，请在 API 易控制台查看。')
  }
  if (status === 429) {
    return new ApiYiError(429, 'API 易请求过于频繁，请稍后重试。')
  }
  if (status === 408 || status === 504) {
    return new ApiYiError(504, '生成等待超时，请稍后重试。')
  }
  if (status === 404 || /model_not_found|模型不存在|无可用渠道/i.test(details)) {
    return new ApiYiError(502, 'API 易暂时无法使用当前图像模型，请检查令牌权限或稍后重试。')
  }
  if (status === 400 || status === 422) {
    return new ApiYiError(422, 'API 易无法处理这组图片，请更换图片后重试。')
  }
  return new ApiYiError(502, 'API 易暂时无法生成图片，请稍后重试。')
}

function readImage(payload) {
  const encoded = payload?.data?.[0]?.b64_json
  if (typeof encoded !== 'string') {
    throw new ApiYiError(502, 'API 易未返回生成图片，请稍后重试。')
  }

  let binary
  try {
    binary = atob(encoded)
  } catch {
    throw new ApiYiError(502, 'API 易返回的图片无法读取，请重试。')
  }
  if (!binary.startsWith(pngSignature)) {
    throw new ApiYiError(502, 'API 易返回的图片无法读取，请重试。')
  }

  const image = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) image[index] = binary.charCodeAt(index)
  return new Blob([image], { type: 'image/png' })
}

export async function generateImage(apiKey, clothing, pet, signal) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!/^[\x21-\x7e]{1,4096}$/.test(key)) {
    throw new ApiYiError(400, '请输入有效的 API 易密钥。')
  }
  const clothingImage = await prepareImage(clothing, '衣服图片', 'clothing')
  const dogImage = await prepareImage(pet, '狗狗照片', 'dog')

  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('image[]', ...dogImage)
  form.append('image[]', ...clothingImage)
  form.append('size', 'auto')
  form.append('quality', 'medium')
  form.append('output_format', 'png')

  if (signal?.aborted) throw new ApiYiError(499, '生成已取消。')
  const controller = new AbortController()
  const abortRequest = () => controller.abort()
  signal?.addEventListener('abort', abortRequest, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abortRequest()
  }, generationTimeout)

  let upstream
  let result
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    result = await upstream.text()
  } catch {
    if (signal?.aborted) throw new ApiYiError(499, '生成已取消。')
    if (timedOut) throw new ApiYiError(504, '生成等待超时，请稍后重试。')
    throw new ApiYiError(502, '无法连接 API 易，请检查网络后重试。')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abortRequest)
  }

  let payload
  try {
    payload = JSON.parse(result)
  } catch {
    payload = null
  }
  if (!upstream.ok || payload?.error) throw upstreamError(upstream.status, payload)
  return readImage(payload)
}
